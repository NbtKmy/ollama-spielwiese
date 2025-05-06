require('dotenv').config();
const { notarize } = require('electron-notarize');

exports.default = async function (context) {
  const { appOutDir, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') return;

  console.log('🛡️ Notarizing...');

  await notarize({
    appBundleId: 'com.nobu.ollama-spielwiese',
    appPath: `${appOutDir}/Ollama Spielwiese.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
    tool: 'notarytool' 
  });
};
