"use strict";
const axios = require("axios");

let Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  homebridge.registerPlatform("homebridge-alko-mower", "AlkoMower", AlkoMowerPlatform);
};

class AlkoMowerPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    if (!api) return;

    api.on("didFinishLaunching", async () => {
      const uuid = UUIDGen.generate(this.config.username);
      const accessory = new this.api.platformAccessory(this.config.name || "AL-KO Mower", uuid);

      const mower = new AlkoMowerAccessory(
        this.log,
        this.config,
        this.api,
        Service,
        Characteristic,
        accessory
      );

      accessory.context.deviceInfo = {
        name: mower.name,
        thingName: mower.thingName
      };

      this.api.registerPlatformAccessories("homebridge-alko-mower", "AlkoMower", [accessory]);
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }
}

class AlkoMowerAccessory {
  constructor(log, config, api, Service, Characteristic, accessory) {
    this.log = log;
    this.api = api;
    this.Service = Service;
    this.Characteristic = Characteristic;
    this.accessory = accessory;
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
    this.mowerState = "UNKNOWN";
    this.mowerSubState = "";
    this.errorState = "";
    this.refreshInProgress = false;

    this.informationService = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, "AL-KO")
      .setCharacteristic(Characteristic.Model, "Robolinho Mower")
      .setCharacteristic(Characteristic.SerialNumber, "Unknown");

    this.switchService = accessory.getService(Service.Switch)
      || accessory.addService(Service.Switch, this.name);
    this.switchService.getCharacteristic(Characteristic.On)
      .onSet(this.handleSwitchSet.bind(this))
      .onGet(this.handleSwitchGet.bind(this));

    this.batteryService = accessory.getService(Service.BatteryService)
      || accessory.addService(Service.BatteryService, this.name + " Battery");
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.currentBatteryLevel);
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.isCharging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBattery ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    this.errorService = accessory.getService("Mower Error")
      || accessory.addService(Service.ContactSensor, "Mower Error", "mowerError");
    this.errorService.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.errorState ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED);

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
    }, 45 * 60 * 1000);
  }

  async authenticate() {
    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    params.append("client_secret", this.clientSecret);
    params.append("grant_type", "password");
    params.append("username", this.username);
    params.append("password", this.password);

    try {
      this.log(`[${this.name}] Requesting new access token...`);
      const response = await axios.post(this.tokenUrl, params);
      const data = response.data;
      this.token = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.log(`[${this.name}] Successfully authenticated. Token expires in ${(data.expires_in || 3600) / 60} minutes.`);
    } catch (error) {
      this.log.error(`[${this.name}] Authentication failed: ${error.message}`);
      throw new Error("Authentication failed");
    }
  }

  async refreshAuthToken() {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      if (!this.refreshToken) throw new Error("Missing refresh token");
      this.log(`[${this.name}] Refreshing access token...`);
      const params = new URLSearchParams();
      params.append("client_id", this.clientId);
      params.append("client_secret", this.clientSecret);
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", this.refreshToken);
      const response = await axios.post(this.tokenUrl, params);
      const data = response.data;
      this.token = data.access_token;
      if (data.refresh_token) this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.log(`[${this.name}] Access token successfully refreshed. Next refresh in ${(data.expires_in || 3600) / 60} minutes.`);
    } catch (error) {
      this.log.error(`[${this.name}] Token refresh failed: ${error.message}`);
      await this.authenticate();
    } finally {
      this.refreshInProgress = false;
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

  async updateMowerState(retries = 1) {
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshAuthToken();
    }

    const url = `${this.apiBaseUrl}/things/${this.thingName}/state/reported`;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const reported = response.data;
      this.currentBatteryLevel = reported.batteryLevel || 0;
      this.lowBattery = this.currentBatteryLevel <= 20;
      const opState = reported.operationState || "";
      const subState = reported.operationSubState || "";
      const opError = reported.operationError || {};
      const errorCode = opError.code;
      const errorDesc = opError.description;

      this.mowerState = opState;
      this.mowerSubState = subState;
      this.errorState = (errorCode && errorCode !== 999 && errorDesc !== "UNKNOWN") ? `${errorCode} (${errorDesc})` : "";

      this.isCharging = /charging/i.test(opState) || /charging/i.test(subState);
      this.isMowerOn = /working|start/i.test(opState);

      const subStateStr = subState ? ` (${subState})` : "";
      const status = this.errorState ? `ERROR${subStateStr}` : `${opState}${subStateStr}`;

      this.errorService.updateCharacteristic(this.Characteristic.ContactSensorState,
        this.errorState ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_DETECTED);

      this.log(`[${this.name}] Battery=${this.currentBatteryLevel}% | Charging=${this.isCharging} | Mowing=${this.isMowerOn} | State=${status}${this.errorState ? ` | Error: ${this.errorState}` : ""}`);
    } catch (error) {
      if (error.response && error.response.status === 401 && retries > 0) {
        this.log.warn(`[${this.name}] Got 401 Unauthorized. Refreshing token and retrying state update...`);
        await this.refreshAuthToken();
        return this.updateMowerState(retries - 1);
      }
      throw new Error(error.message || 'Failed to fetch mower state');
    }
  }

  async handleSwitchSet(value) {
    this.log(`[${this.name}] handleSwitchSet wrapper called with value: ${value}`);
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
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Unauthorized command. Refreshing token and retrying...`);
        await this.refreshAuthToken();
        return this.handleSwitchSet(value);
      }
      this.log.error(`[${this.name}] Failed to send command: ${err.message}`);
    }
  }

  handleSwitchGet() {
    return this.isMowerOn;
  }
}
