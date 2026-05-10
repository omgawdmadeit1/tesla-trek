const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;
const TESLA_CLIENT_ID = process.env.TESLA_CLIENT_ID;
const TESLA_CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const NGROK_URL = process.env.NGROK_URL;
const REDIRECT_URI = `${NGROK_URL}/auth/callback`;

let currentAccessToken = null;
let currentRefreshToken = null;
let tokenExpiresAt = null;

// ==================== TESLA PUBLIC KEY ROUTE ====================
app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  const publicKeyPath = path.join(__dirname, 'public-key.pem');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', 'attachment; filename="com.tesla.3p.public-key.pem"');
  res.sendFile(publicKeyPath);
});

// ==================== MIDDLEWARE ====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ==================== ROUTES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tesla-trek.html'));
});

app.get('/auth/tesla', (req, res) => {
  const authUrl = `https://auth.tesla.com/oauth2/v3/authorize?client_id=${TESLA_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid%20offline_access%20vehicle_location%20vehicle_device_data&state=tesla-trek`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code');

  try {
    const tokenResponse = await axios.post(
      'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    currentAccessToken = tokenResponse.data.access_token;
    currentRefreshToken = tokenResponse.data.refresh_token;
    tokenExpiresAt = Date.now() + (tokenResponse.data.expires_in * 1000);

    res.redirect('/?connected=true');
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).send('Connection failed');
  }
});

app.get('/api/vehicle-data', async (req, res) => {
  if (!currentAccessToken) return res.status(401).json({ error: 'Not connected' });

  if (isTokenExpired()) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return res.status(401).json({ error: 'Session expired' });
  }

  try {
    const vehiclesRes = await axios.get('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles', {
      headers: { Authorization: `Bearer ${currentAccessToken}` }
    });
    const vehicle = vehiclesRes.data.response[0];

    const dataRes = await axios.get(`https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vehicle.vin}/vehicle_data`, {
      headers: { Authorization: `Bearer ${currentAccessToken}` }
    });

    res.json({ vehicle, data: dataRes.data.response });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Tesla Trek running on http://localhost:${PORT}\n`);
});

// ==================== HELPER FUNCTIONS ====================
async function refreshAccessToken() {
  if (!currentRefreshToken) return false;
  try {
    const response = await axios.post(
      'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: TESLA_CLIENT_ID,
        client_secret: TESLA_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    currentAccessToken = response.data.access_token;
    currentRefreshToken = response.data.refresh_token || currentRefreshToken;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
    console.log('🔄 Token refreshed');
    return true;
  } catch (error) {
    console.error('Token refresh failed');
    return false;
  }
}

function isTokenExpired() {
  return !currentAccessToken || (tokenExpiresAt && Date.now() > tokenExpiresAt - 60000);
}