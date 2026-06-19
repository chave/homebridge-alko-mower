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

    api.on("didFinishLaunching", () => {
      const uuid = UUIDGen.generate(this.config.username);

      // Check if accessory is already cached from a previous session
      const cached = this.accessories.find(a => a.UUID === uuid);

      // Remove any stale duplicates
      const stale = this.accessories.filter(a => a.UUID !== uuid);
      if (stale.length > 0) {
        this.api.unregisterPlatformAccessories("homebridge-alko-mower", "AlkoMower", stale);
      }

      if (cached) {
        this.log("Restoring AL-KO Mower from cache.");
        new AlkoMowerAccessory(this.log, this.config, this.api, Service, Characteristic, cached);
      } else {
        const accessory = new this.api.platformAccessory(this.config.name || "AL-KO Mower", uuid);
        new AlkoMowerAccessory(this.log, this.config, this.api, Service, Characteristic, accessory);
        this.api.registerPlatformAccessories("homebridge-alko-mower", "AlkoMower", [accessory]);
      }
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
    // Restore thingName from config, then cached context, then null (triggers discovery)
    this.thingName = config.thingName || accessory.context.thingName || null;
    this.debug = config.debug || false;

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
    this.isConnected = true;
    this.bladeChange = false;
    this.bladeLifeLevel = 100;
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

    const BatteryService = Service.Battery || Service.BatteryService;
    this.batteryService = accessory.getService(BatteryService)
      || accessory.addService(BatteryService, this.name + " Battery");
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.currentBatteryLevel);
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.isCharging
        ? Characteristic.ChargingState.CHARGING
        : Characteristic.ChargingState.NOT_CHARGING);
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.lowBattery
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    this.errorService = accessory.getService("Mower Error")
      || accessory.addService(Service.ContactSensor, "Mower Error", "mowerError");
    this.errorService.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.errorState
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED);
    // isConnected=false: reported state is stale. Flag a fault on the error sensor.
    this.errorService.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.isConnected
        ? Characteristic.StatusFault.NO_FAULT
        : Characteristic.StatusFault.GENERAL_FAULT);

    this.filterService = accessory.getService("Mower Blades")
      || accessory.addService(Service.FilterMaintenance, "Mower Blades", "mowerBlades");
    this.filterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.bladeChange
        ? Characteristic.FilterChangeIndication.CHANGE_FILTER
        : Characteristic.FilterChangeIndication.FILTER_OK);
    this.filterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => this.bladeLifeLevel);

    if (api) {
      api.on("shutdown", () => {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.refreshInterval) clearInterval(this.refreshInterval);
      });
    }

    this.init();
  }

  async init() {
    let initialized = false;
    try {
      await this.authenticate();
      if (!this.thingName) {
        await this.discoverMower();
        // Persist discovered thingName so restarts don't require re-discovery
        this.accessory.context.thingName = this.thingName;
      }
      initialized = true;
    } catch (err) {
      this.log.error(`[${this.name}] Initialization failed: ${err.message || err}`);
      return;
    }

    if (!initialized) return;

    await this.updateMowerState().catch(err => {
      this.log.error(`[${this.name}] Initial state update failed: ${err.message || err}`);
    });

    this.pollInterval = setInterval(() => {
      this.updateMowerState().catch(err => {
        this.log.error(`[${this.name}] Error updating mower state: ${err.message || err}`);
      });
    }, 60 * 1000);

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
    params.append("scope", "alkoCustomerId alkoCulture offline_access introspection");

    try {
      this.log(`[${this.name}] Requesting new access token...`);
      const response = await axios.post(this.tokenUrl, params, {
        timeout: 15000,
      });
      const data = response.data;
      this.token = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.log(`[${this.name}] Authenticated. Token expires in ${Math.round((data.expires_in || 3600) / 60)} minutes.`);
    } catch (error) {
      const detail = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      this.log.error(`[${this.name}] Authentication failed: ${detail}`);
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

      const response = await axios.post(this.tokenUrl, params, {
        timeout: 15000,
      });
      const data = response.data;
      this.token = data.access_token;
      if (data.refresh_token) this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      this.log(`[${this.name}] Access token refreshed.`);
    } catch (error) {
      this.log.error(`[${this.name}] Token refresh failed: ${error.message}`);
      await this.authenticate();
    } finally {
      this.refreshInProgress = false;
    }
  }

  async discoverMower() {
    const url = `${this.apiBaseUrl}/things`;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 15000,
      });
      const devices = response.data;
      if (!devices || !devices.length) throw new Error("No AL-KO devices found");
      const mower = devices.find(d => d.thingType && d.thingType.toUpperCase().includes("ROBOLINHO")) || devices[0];
      this.thingName = mower.thingName;
      this.log(`[${this.name}] Discovered mower: ${this.thingName}`);
    } catch (error) {
      const detail = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      throw new Error(`Device discovery failed: ${detail}`);
    }
  }

  async updateMowerState(retries = 1) {
    if (!this.thingName) {
      this.log.warn(`[${this.name}] Cannot update state: thingName not set.`);
      return;
    }
    if (Date.now() >= this.tokenExpiresAt) {
      await this.refreshAuthToken();
    }

    const url = `${this.apiBaseUrl}/things/${this.thingName}/state/reported`;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 15000,
      });
      const reported = response.data;
      if (this.debug) this.log(`[${this.name}] Raw reported state: ${JSON.stringify(reported)}`);
      this.isConnected = reported.isConnected !== false;
      this.currentBatteryLevel = reported.batteryLevel || 0;
      this.lowBattery = this.currentBatteryLevel <= 20;

      // ponytail: bladesService assumed to be the service interval, remainingBladeLifetime the remainder.
      // If the unit/scale turns out different, CHANGE_FILTER (remaining<=0) stays correct; only the % is a guess.
      // When offline the snapshot is stale — don't raise "replace" off week-old data; StatusFault carries it.
      const bladeTotal = reported.bladesService || 0;
      const bladeRemaining = reported.remainingBladeLifetime || 0;
      this.bladeChange = this.isConnected && bladeRemaining <= 0;
      this.bladeLifeLevel = bladeTotal ? Math.max(0, Math.min(100, Math.round((bladeRemaining / bladeTotal) * 100))) : 100;

      const opState = reported.operationState || "";
      const subState = reported.operationSubState || "";
      const opError = reported.operationError || {};
      const errorCode = opError.code;
      const errorDesc = opError.description;

      this.mowerState = opState;
      this.mowerSubState = subState;
      // ponytail: pinlock/lockouts aren't in operationError (it reports 999/UNKNOWN).
      // Key on operationSituation: "OPERATION_NOT_PERMITTED_LOCKED" / subState LOCKED_PIN.
      // NOT situationFlags.operationPermitted — that's false whenever idle/off-window, not a fault.
      // Gated on isConnected: a stale offline snapshot shouldn't raise a lockout; StatusFault carries it.
      const situation = reported.operationSituation || "";
      const blocked = this.isConnected && /LOCK/i.test(situation + subState);
      this.errorState = (errorCode && errorCode !== 999 && errorDesc !== "UNKNOWN")
        ? `${errorCode} (${errorDesc})`
        : blocked
          ? `LOCKED (${subState || situation || opState})`
          : "";

      const prevStatus = `${this.mowerState}|${this.mowerSubState}|${this.currentBatteryLevel}|${this.errorState}`;
      this.isCharging = /charging/i.test(opState) || /charging/i.test(subState);
      this.isMowerOn = /working|start/i.test(opState);
      const newStatus = `${opState}|${subState}|${reported.batteryLevel || 0}|${this.errorState}`;
      const changed = prevStatus !== newStatus;

      this.errorService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        this.errorState
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED
      );
      this.errorService.updateCharacteristic(
        this.Characteristic.StatusFault,
        this.isConnected
          ? this.Characteristic.StatusFault.NO_FAULT
          : this.Characteristic.StatusFault.GENERAL_FAULT
      );
      this.filterService.updateCharacteristic(
        this.Characteristic.FilterChangeIndication,
        this.bladeChange
          ? this.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.Characteristic.FilterChangeIndication.FILTER_OK
      );
      this.filterService.updateCharacteristic(this.Characteristic.FilterLifeLevel, this.bladeLifeLevel);
      this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, this.currentBatteryLevel);
      this.batteryService.updateCharacteristic(
        this.Characteristic.ChargingState,
        this.isCharging
          ? this.Characteristic.ChargingState.CHARGING
          : this.Characteristic.ChargingState.NOT_CHARGING
      );

      if (changed) {
        const subStateStr = subState ? ` (${subState})` : "";
        const status = this.errorState ? `ERROR${subStateStr}` : `${opState}${subStateStr}`;
        this.log(`[${this.name}] Battery=${this.currentBatteryLevel}% | Charging=${this.isCharging} | Mowing=${this.isMowerOn} | State=${status}${this.errorState ? ` | Error: ${this.errorState}` : ""}`);
      }
    } catch (error) {
      if (error.response && error.response.status === 401 && retries > 0) {
        this.log.warn(`[${this.name}] Got 401. Refreshing token and retrying...`);
        await this.refreshAuthToken();
        return this.updateMowerState(retries - 1);
      }
      const detail = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      throw new Error(`Failed to fetch mower state: ${detail}`);
    }
  }

  async handleSwitchSet(value) {
    if (!this.thingName) {
      this.log.error(`[${this.name}] Cannot send command: thingName not set.`);
      return;
    }
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
          timeout: 15000,
        }
      );
      this.log(`[${this.name}] Sent command: ${desiredState}`);
      setTimeout(() => {
        this.updateMowerState().catch(err => {
          this.log.error(`[${this.name}] Failed to update state after command: ${err.message}`);
        });
      }, 5000);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.log.warn(`[${this.name}] Unauthorized. Refreshing token and retrying...`);
        await this.refreshAuthToken();
        return this.handleSwitchSet(value);
      }
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      this.log.error(`[${this.name}] Failed to send command: ${detail}`);
    }
  }

  handleSwitchGet() {
    return this.isMowerOn;
  }
}
