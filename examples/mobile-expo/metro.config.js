// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Captures, release checks and Storybook builds land in .stet/; Metro must not
// watch them, or every saved capture triggers a Fast Refresh on the devices.
const blockList = [config.resolver.blockList].flat().filter(Boolean);
config.resolver.blockList = [...blockList, /[\\/]\.stet[\\/].*/];

module.exports = config;
