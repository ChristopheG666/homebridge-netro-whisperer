/*jshint esversion: 6,node: true,-W041: false */
"use strict";
var inherits = require('util').inherits;
var Service, Characteristic;
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

        // 

        CustomCharacteristic.AirPressure = function() {
            Characteristic.call(this, strings.AIR_PRESSURE, CustomUUID.AirPressure);
            this.setProps({
                format: Characteristic.Formats.UINT16,
                unit: "mBar",
                maxValue: 100,
                minValue: 0,
                minStep: 1,
                perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
            });
            this.value = this.getDefaultValue();
        };
        inherits(CustomCharacteristic.AirPressure, Characteristic);


        EveService.WeatherService = function(displayName, subtype) {
            Service.call(this, displayName, 'E863F001-079E-48FF-8F27-9C2605A29F52', subtype);
            this.addCharacteristic(Characteristic.CurrentTemperature);
            this.addCharacteristic(Characteristic.CurrentRelativeHumidity);
            this.addCharacteristic(CustomCharacteristic.AirPressure);
            this.getCharacteristic(Characteristic.CurrentTemperature)
                .setProps({
                    minValue: -40,
                    maxValue: 60
                });
        };
        inherits(EveService.WeatherService, Service);

        this.informationService = new Service.AccessoryInformation();
        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, "Netro")
            .setCharacteristic(Characteristic.Model, "Whisperer sensor")
            .setCharacteristic(Characteristic.FirmwareRevision, version)
            .setCharacteristic(Characteristic.SerialNumber, this.serial);


        this.fakeWeatherEveService = new EveService.WeatherService(this.name);
        this.fakeWeatherEveService.getCharacteristic(Characteristic.CurrentTemperature).on("get", this.getTemperature.bind(this));

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
            return [this.informationService, this.tempService, this.humidityService, this.fakeWeatherEveService, this.loggingService];
        },

        getTemperature: function(callback) {
            this.updateSensorData();
            callback(null, this.temperature);
        },

        getHumidity: function(callback) {
            this.updateSensorData();
            callback(null, this.humidity);
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
                    that.temperature = temperature;
                    that.humidity = humidity;
                    that.airPressure = battery;

                    that.fakeWeatherEveService.setCharacteristic(Characteristic.CurrentTemperature, that.temperature);
                    that.fakeWeatherEveService.setCharacteristic(Characteristic.CurrentRelativeHumidity, that.humidity);
                    that.fakeWeatherEveService.setCharacteristic(CustomCharacteristic.AirPressure, that.airPressure);

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