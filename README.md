# homebridge-alko-mower

Control AL-KO Robolinho mowers via Homebridge.

This Homebridge plugin allows you to control and monitor AL-KO Robolinho robotic mowers using the official AL-KO cloud APIs. Easily start, stop, and check battery levels directly from your Home app or Siri voice commands.

---

## Features

- Start or stop mowing
- Monitor battery percentage
- See if the mower is charging
- Automatic polling and status updates
- OAuth2 token refresh handled automatically
- Intelligent retry behavior on token expiration
- UI configuration with Homebridge Config UI X

---

## Installation

Install via Homebridge UI or with npm:

```bash
npm install -g homebridge-alko-mower
```

---

## Configuration

You can configure the plugin using the Homebridge UI (recommended), or manually in `config.json`:

### Example:

```json
{
  "platform": "AlkoMower",
  "name": "AL-KO Mower",
  "clientId": "your_client_id",
  "clientSecret": "your_client_secret",
  "username": "your_email@domain.com",
  "password": "your_alko_account_password"
}
```

>  **Important**: AL-KO requires API credentials (`clientId`, `clientSecret`) that are different from your login. See below.

---

## Getting Started with AL-KO API Access

To use this Homebridge plugin, you'll need credentials from AL-KO beyond your regular app login (email and password):

### Required:

- **AL-KO app username (email)**
- **AL-KO app password**
- **Client ID** and **Client Secret** from the AL-KO developer portal

### How to Get API Credentials

To register and request API access:

[Visit the AL-KO Developer API Access Page](https://alko-garden.com/api-access)

1. Submit the request form with your details.
2. Once approved, you'll receive a `client_id` and `client_secret` for use with this plugin.
3. Then plug those into your Homebridge config or UI.

---

## Development

```bash
npm install
npm run lint
npm run test
```

---

## License

MIT

