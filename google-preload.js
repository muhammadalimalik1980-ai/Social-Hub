// Runs before every page. Only on Google's sign-in page it makes the browser look like Chrome.
const { webFrame } = require('electron');

if (location.hostname === 'accounts.google.com') {
  const V = process.versions.chrome, M = V.split('.')[0];
  webFrame.executeJavaScript('(' + function (V, M) {
    const b = [{ brand: 'Chromium', version: M }, { brand: 'Google Chrome', version: M }, { brand: 'Not?A_Brand', version: '99' }];
    const full = b.map(x => ({ brand: x.brand, version: V }));
    const uad = {
      brands: b, mobile: false, platform: 'Windows',
      getHighEntropyValues: async () => ({ brands: b, mobile: false, platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', bitness: '64', model: '', uaFullVersion: V, fullVersionList: full }),
      toJSON() { return { brands: b, mobile: false, platform: 'Windows' }; },
    };
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => uad, configurable: true });
    if (!window.chrome) window.chrome = { runtime: {}, app: {}, loadTimes() {}, csi() {} };
  } + ')(' + JSON.stringify(V) + ',' + JSON.stringify(M) + ')');
}
