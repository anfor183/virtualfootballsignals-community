const axios = require('axios');

const PROXY_CONFIG = {
  server: '127.0.0.1:8080',
  username: '6542VD8PfX15XYL',
  password: 'KQ6Ao9bABVcIkYH'
};

const proxyUrl = `http://${PROXY_CONFIG.username}:${PROXY_CONFIG.password}@${PROXY_CONFIG.server}`;

const testProxy = async () => {
  try {
    const response = await axios.get('http://lumtest.com/myip.json', {
      proxy: {
        host: '127.0.0.1',
        port: 47357,
        auth: {
          username: PROXY_CONFIG.username,
          password: PROXY_CONFIG.password
        }
      }
    });
    console.log('Proxy test successful:', response.data);
  } catch (error) {
    console.error('Proxy test failed:', error.message);
  }
};

testProxy();
