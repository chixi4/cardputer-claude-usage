import os from 'os';

export function localAddresses(port) {
  const addresses = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      addresses.push({
        name,
        address: item.address,
        url: `http://${item.address}:${port}/`,
      });
    }
  }
  return addresses;
}
