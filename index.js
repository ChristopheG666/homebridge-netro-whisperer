/*jshint esversion: 6,node: true,-W041: false */
"use strict";
var inherits = require('util').inherits;
var Service, Characteristic, Formats, Perms;
var timeout;

const version = require('./package.json').version;
const _http_base = require("homebridge-http-base");
const http = _http_base.http;
const configParser = _http_base.configParser;
const utils = _http_base.utils;


var CustomUUID = {
    // Eve
    AirPressure: 'E863F10F-079E-48FF-8F27-9C2605A29F52'
};
var strings = {
    AIR_PRESSURE: "Air pressure"
};

var CustomCharacteristic = {};
var EveService = {};

module.exports = function(homebridge) {
    var FakeGatoHistoryService = require('fakegato-history')(homebridge);
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Formats = homebridge.hap.Formats || Characteristic.Formats;
    Perms = homebridge.hap.Perms || Characteristic.Perms;
    homebridge.registerAccessory("homebridge-netro-whisperer", "netro-whisperer", NetroSensor);

    function NetroSensor(log, config) {

        this.log = log;

        this.statusPatternTemp = configParser.parsePattern("celsius\":([0-9.]*)");
        this.statusPatternHumidity = configParser.parsePattern("moisture\":([0-9.]*)");
        this.statusPatternBattery = configParser.parsePattern("battery_level\":([0-9.]*)");
        this.statusPatternId = configParser.parsePattern("\"id\":([0-9]*)");
        this.statusPatternTime = configParser.parsePattern("\"time\".*?time\":\"([0-9-T:]*)\"");

        if (!config.sensorSerial) {
            this.log.warn("Missing mandatory property 'sensorSerial'");
            this.log.warn("Abort'");
            return;
        }
        this.sensorSerial = config.sensorSerial;

        this.name = config.name;
        this.displayName = config.name;
        this.serial = config.serial || this.sensorSerial;
        this.debug = config.debug || false;
        this.pullInterval = config.pullInterval || 30;

        this.apiURL = "http://api.netrohome.com/npa/v1/sensor_data.json?key=";
        if (config.apiUrl) // Allow to overide the api url
            this.apiURL = config.apiUrl;


        try {
            this.getUrl = configParser.parseUrlProperty(this.apiURL + this.sensorSerial);
        } catch (error) {
            this.log.warn("Error occurred while parsing 'getUrl': " + error.message);
            this.log.warn("Aborting...");
            return;
        }

        this.informationService = new Service.AccessoryInformation();
        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, "Netro")
            .setCharacteristic(Characteristic.Model, "Whisperer sensor")
            .setCharacteristic(Characteristic.FirmwareRevision, version)
            .setCharacteristic(Characteristic.SerialNumber, this.serial);


        // NOTE: The custom Eve WeatherService (UUID E863F001...) and its custom
        // "Air pressure" characteristic (unit "mBar") are intentionally NOT
        // exposed to HomeKit. iOS validates the whole accessory database and
        // rejects the non-standard unit/metadata, flagging the accessory as
        // "out of compliance". Live values are exposed via the standard
        // Temperature/Humidity/Battery services below, and history is still
        // recorded through the FakeGato logging service.

        this.loggingService = new FakeGatoHistoryService("weather", this, {
            storage: 'fs',
            disableTimer: true
        });

        this.tempService = new Service.TemperatureSensor(this.name);
        this.tempService.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                minValue: -100,
                maxValue: 100
            })
            .on("get", this.getTemperature.bind(this));
        this.humidityService = new Service.HumiditySensor(this.name);
        this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on("get", this.getHumidity.bind(this));

        this.lowBatteryThreshold = config.lowBatteryThreshold || 20;
        this.batteryService = new Service.Battery(this.name);
        this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
            .on("get", this.getBatteryLevel.bind(this));
        this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
            .on("get", this.getStatusLowBattery.bind(this));
        // Sensor is not rechargeable.
        this.batteryService.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);

        // Initialize with valid, in-range values so HomeKit never reads an
        // undefined or out-of-range value (which triggers "Accessory out of
        // compliance" in Home.app).
        this.temperature = 0;
        this.humidity = 0;
        // Battery is kept in `airPressure` as well so the FakeGato/Eve history
        // graph (which logs it as "pressure") keeps working.
        this.airPressure = 100;

        this.lastUpdate = new Date(0);

        this.tzoffset = (new Date()).getTimezoneOffset() * 60000;
        this.log.debug('tzoffset = ' + this.tzoffset);

        this.updateSensorData();
    }

    NetroSensor.prototype = {
        identify: function(callback) {
            this.log("Identify requested!");
            callback(); // success
        },

        getServices: function() {
            return [this.informationService, this.tempService, this.humidityService, this.batteryService, this.loggingService];
        },

        getTemperature: function(callback) {
            this.updateSensorData();
            callback(null, this.temperature);
        },

        getHumidity: function(callback) {
            this.updateSensorData();
            callback(null, this.humidity);
        },

        getBatteryLevel: function(callback) {
            this.updateSensorData();
            callback(null, this.airPressure);
        },

        getStatusLowBattery: function(callback) {
            this.updateSensorData();
            callback(null, this.airPressure <= this.lowBatteryThreshold ?
                Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
                Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        },

        updateSensorData: function() {
            var that = this;

            let endTime = new Date();
            var timeDiff = endTime - this.lastUpdate; //in ms
            // strip the ms
            timeDiff /= 1000;

            if (this.debug)
                this.log.debug('updateSensorData (last update since: ' + timeDiff + ')');

            if (timeDiff < this.pullInterval * 60) {
                if (this.debug)
                    this.log(`getSensors() returning cached value ` + that.temperature);
                return;
            }

            this.lastUpdate = new Date();
            http.httpRequest(this.getUrl, (error, response, body) => {
                if (!error) {

                    let id = -666;
                    let time = new Date();
                    let temperature = -666;
                    let humidity = -666;
                    let battery = -666;

                    if (this.statusPatternId) {
                        try {
                            id = utils.extractValueFromPattern(this.statusPatternId, body, this.patternGroupToExtract);
                        } catch (error) {
                            this.log("updateSensorData() error occurred while extracting id from body: " + error.message);
                        }
                    }

                    if (this.statusPatternTime) {
                        try {
                            time = new Date(new Date(utils.extractValueFromPattern(this.statusPatternTime, body, this.patternGroupToExtract)).getTime() - this.tzoffset);
                        } catch (error) {
                            this.log("updateSensorData() error occurred while extracting time from body: " + error.message);
                        }
                    }

                    if (this.statusPatternTemp) {
                        try {
                            temperature = utils.extractValueFromPattern(this.statusPatternTemp, body, this.patternGroupToExtract);
                        } catch (error) {
                            this.log("updateSensorData() error occurred while extracting temperature from body: " + error.message);
                        }
                    }

                    if (this.statusPatternHumidity) {
                        try {
                            humidity = utils.extractValueFromPattern(this.statusPatternHumidity, body, this.patternGroupToExtract);
                        } catch (error) {
                            this.log("updateSensorData() error occurred while extracting humidity from body: " + error.message);
                        }
                    }

                    if (this.statusPatternBattery) {
                        try {
                            battery = utils.extractValueFromPattern(this.statusPatternBattery, body, this.patternGroupToExtract);
                        } catch (error) {
                            this.log("updateSensorData() error occurred while extracting battery from body: " + error.message);
                        }
                    }

                    if (id == that.id) {
                        if (this.debug) {
                            this.log("Measure is the same, do not update history (Time: %s (%s), id: %s Temperature is currently at %s, humidity is currently at %s, battery is %s)",
                             time, time.getTime() / 1000, id, temperature, humidity, battery);
                            return;
                        }
                    }
                    // if (this.debug)
                    this.log("Time: %s (%s), id: %s Temperature is currently at %s, humidity is currently at %s, battery is %s",
                            time, time.getTime() / 1000, id, temperature, humidity, battery);

                    that.id = id;

                    // Only accept successfully extracted values; -666 is the
                    // error sentinel and must never reach HomeKit. Clamp to the
                    // declared characteristic ranges to stay HAP-compliant.
                    let clamp = (v, min, max) => Math.min(max, Math.max(min, v));

                    if (temperature != -666)
                        that.temperature = clamp(temperature, -100, 100);
                    if (humidity != -666)
                        that.humidity = clamp(humidity, 0, 100);
                    if (battery != -666)
                        that.airPressure = clamp(battery, 0, 100);

                    that.tempService.setCharacteristic(Characteristic.CurrentTemperature, that.temperature);
                    that.humidityService.setCharacteristic(Characteristic.CurrentRelativeHumidity, that.humidity);
                    // Duplicate the battery value into the real BatteryService.
                    that.batteryService.setCharacteristic(Characteristic.BatteryLevel, that.airPressure);
                    that.batteryService.setCharacteristic(Characteristic.StatusLowBattery,
                        that.airPressure <= that.lowBatteryThreshold ?
                            Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
                            Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

                    that.loggingService.addEntry({
                        time: time.getTime() / 1000,
                        temp: that.temperature,
                        pressure: that.airPressure,
                        humidity: that.humidity
                    });

                } else {
                    that.log.debug("Error retrieving the sensor data: %s", error);
                }
            });
            timeout = setTimeout(this.updateSensorData.bind(this), this.pullInterval * 60 * 1000);
        }
    };
};