'use strict';

const fs = require('fs');
const path = require('path');

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return null;
}

function mergeProfilePackage(userPkg, presetPkg) {
  const merged = { ...(userPkg || {}) };
  merged.name = merged.name || presetPkg.name || 'dsh-profile-web';
  merged.private = true;
  merged.dependencies = {
    ...(presetPkg.dependencies || {}),
    ...(userPkg && userPkg.dependencies ? userPkg.dependencies : {})
  };

  const userBundles = (userPkg && userPkg.dsh && userPkg.dsh.profile && Array.isArray(userPkg.dsh.profile.bundles))
    ? userPkg.dsh.profile.bundles
    : [];
  const presetBundles = (presetPkg && presetPkg.dsh && presetPkg.dsh.profile && Array.isArray(presetPkg.dsh.profile.bundles))
    ? presetPkg.dsh.profile.bundles
    : [];

  const combinedBundles = [...new Set([...presetBundles, ...userBundles])];

  merged.dsh = {
    ...(userPkg && userPkg.dsh ? userPkg.dsh : {}),
    profile: {
      ...(userPkg && userPkg.dsh && userPkg.dsh.profile ? userPkg.dsh.profile : {}),
      bundles: combinedBundles
    }
  };

  return merged;
}

function hydratePresetPlugins(presetProfileDir, dshHome) {
  if (!presetProfileDir || !fs.existsSync(presetProfileDir) || !dshHome) {
    return { hydrated: false, reason: 'missing-source-or-target' };
  }

  try {
    fs.mkdirSync(dshHome, { recursive: true });

    const userWebDir = path.join(dshHome, 'profiles', 'web');
    const presetWebDir = path.join(presetProfileDir, 'profiles', 'web');

    if (!fs.existsSync(userWebDir) && fs.existsSync(presetWebDir)) {
      fs.mkdirSync(path.dirname(userWebDir), { recursive: true });
      fs.cpSync(presetWebDir, userWebDir, { recursive: true });
      return { hydrated: true, mode: 'full-copy' };
    }

    const userPkgPath = path.join(userWebDir, 'package.json');
    const presetPkgPath = path.join(presetWebDir, 'package.json');

    if (fs.existsSync(presetPkgPath)) {
      const presetPkg = readJsonSafe(presetPkgPath) || {};
      const userPkg = readJsonSafe(userPkgPath) || {};
      const mergedPkg = mergeProfilePackage(userPkg, presetPkg);
      fs.mkdirSync(userWebDir, { recursive: true });
      fs.writeFileSync(userPkgPath, JSON.stringify(mergedPkg, null, 2));

      if (fs.existsSync(presetWebDir)) {
        for (const entry of fs.readdirSync(presetWebDir, { withFileTypes: true })) {
          if (entry.name === 'package.json') continue;
          const targetPath = path.join(userWebDir, entry.name);
          const sourcePath = path.join(presetWebDir, entry.name);
          if (!fs.existsSync(targetPath)) {
            fs.cpSync(sourcePath, targetPath, { recursive: true });
          }
        }
      }
      return { hydrated: true, mode: 'merged' };
    }

    return { hydrated: false, reason: 'no-preset-package' };
  } catch (err) {
    console.warn('[preset-hydrator] Failed to hydrate:', err.message);
    return { hydrated: false, reason: err.message };
  }
}

module.exports = {
  readJsonSafe,
  mergeProfilePackage,
  hydratePresetPlugins
};
