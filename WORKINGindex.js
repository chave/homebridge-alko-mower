"use strict";
const axios = require("axios");

let Service, Characteristic;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerPlatform("homebridge-alko-mower", "AlkoMower", AlkoMowerPlatform);
};

class AlkoMowerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!api) return;

    api.on("didFinishLaunching", () => {
      const mower = new AlkoMowerAccessory(
        this.log,
        this.config,
        api,
        Service,
        Characteristic
      );
      this.accessories.push(mower);
    });
  }

  configureAccessory(accessory) {
    // Not used with dynamic platform
  }
}

class AlkoMowerAccessory {
  constructor(log, config, api, Service, Characteristic) {
    this.log = log;
    this.api = api;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.name = config.name || "AL-KO Mower";
    this.username = config.username;
    this.password = config.password;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.thingName = config.thingName || null;

    this.token = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    this.tokenUrl = "https://idp.al-ko.com/connect/token";
    this.apiBaseUrl = "https://api.al-ko.com/v1/iot";
    this.isMowerOn = false;
    this.currentBatteryLevel = 0;
    this.isCharging = false;
    this.lowBattery = false;

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, "AL-KO")
      .setCharacteristic(Characteristic.Model, "Robolinho Mower")
      .setCharacteristic(Characteristic.SerialNumber, "Unknown");

    this.switchService = new Service.Switch(this.name);
    this.switchService.getCharacteristic(Characteristic.On)
      .onSet(this.handleSwitchSet.bind(this))
      .onGet(this.handleSwitchGet.bind(this));

    this.batteryService = new Service.BatteryService(this.name + " Battery");
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.currentBatteryLevel);
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.isCharging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBattery ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    if (api) {
      api.on('shutdown', () => {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.refreshInterval) clearInterval(this.refreshInterval);
      });
    }

    this.init();
  }

  async init() {
    try {
      await this.authenticate();
      if (!this.thingName) await this.discoverMower();
    } catch (err) {
      this.log.error(`[${this.name}] Initialization failed: ${err.message || err}`);
    }

    this.pollInterval = setInterval(() => {
      this.updateMowerState().catch(err => {
        this.log.error(`[${this.name}] Error updating mower state: ${err.message || err}`);
      });
    }, 60 * 1000);

    this.updateMowerState().catch(err => {
      this.log.error(`[${this.name}] Initial state update failed: ${err.message || err}`);
    });

    this.refreshInterval = setInterval(() => {
      this.refreshAuthToken().catch(err => {
        this.log.error(`[${this.name}] Token refresh error: ${err.message || err}`);
      });
    }, 6 * 60 * 60 * 1000);
  }

  async authenticate() {
    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    params.append("client_secret", this.clientSecret);
    params.append("grant_type", "password");
    params.append("username", this.username);
    params.append("password", this.password);

    try {
      const response = await axios.post(this.tokenUrl, params);
      const data = response.data;
      this.token = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    } catch (error) {
      throw new Error("Authentication failed");
    }
  }

  async refreshAuthToken() {
    if (!this.refreshToken) throw new Error("Missing refresh token");
    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    params.append("client_secret", this.clientSecret);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", this.refreshToken);
    try {
      const response = await axios.post(this.tokenUrl, params);
      const data = response.data;
      this.token = data.access_token;
      if (data.refresh_token) this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    } catch (error) {
      await this.authenticate();
    }
  }

  async discoverMower() {
    const url = `${this.apiBaseUrl}/things`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const devices = response.data;
    if (!devices.length) throw new Error("No AL-KO devices found");
    const mower = devices.find(d => d.thingType && d.thingType.includes("ROBOLINHO")) || devices[0];
    this.thingName = mower.thingName;
  }

  async updateMowerState() {
    const url = `${this.apiBaseUrl}/things/${this.thingName}/state/reported`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const reported = response.data;
    this.currentBatteryLevel = reported.batteryLevel || 0;
    this.lowBattery = this.currentBatteryLevel <= 20;
    const opState = reported.operationState || "";
    const subState = reported.operationSubState || "";
    this.isCharging = /charging/i.test(opState) || /charging/i.test(subState);
    this.isMowerOn = /working|start/i.test(opState);
    this.log(`[${this.name}] Battery=${this.currentBatteryLevel}% | Charging=${this.isCharging} | Mowing=${this.isMowerOn}`);
  }

  async handleSwitchSet(value) {
    const desiredState = value ? "WORKING" : "HOMING";
    const url = `${this.apiBaseUrl}/things/${this.thingName}/state/desired`;
    try {
      await axios.patch(
        url,
        { operationState: desiredState },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
        }
      );
      this.log(`[${this.name}] Sent command: ${desiredState}`);
      setTimeout(() => this.updateMowerState().catch(err => {
        this.log.error(`[${this.name}] Failed to update state after command: ${err.message}`);
      }), 5000);
    } catch (err) {
      this.log.error(`[${this.name}] Failed to send command: ${err.message}`);
    }
  }

  handleSwitchGet() {
    return this.isMowerOn;
  }

  getServices() {
    return [this.informationService, this.switchService, this.batteryService];
  }
}
