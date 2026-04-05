function toSafeVersionList(versions = []) {
  return Array.isArray(versions) ? versions.filter(Boolean) : [];
}

function sortByPublishedDateDescending(versions = []) {
  return [...toSafeVersionList(versions)].sort((left, right) => {
    const leftDate = left?.datePublished ? new Date(left.datePublished).getTime() : 0;
    const rightDate = right?.datePublished ? new Date(right.datePublished).getTime() : 0;
    return rightDate - leftDate;
  });
}

export function pickPreferredSearchCardVersion(candidateVersions = []) {
  const safeVersions = toSafeVersionList(candidateVersions);
  if (safeVersions.length === 0) {
    return null;
  }

  const stableVersions = safeVersions.filter((version) => version.isStable !== false);
  const versionsToUse = stableVersions.length > 0 ? stableVersions : safeVersions;
  return sortByPublishedDateDescending(versionsToUse)[0] || null;
}

function selectBestSearchCardVersion(versions = []) {
  const safeVersions = toSafeVersionList(versions);
  if (safeVersions.length === 0) {
    return null;
  }

  const stableVersions = safeVersions.filter((version) => version.isStable !== false);
  const versionsToUse = stableVersions.length > 0 ? stableVersions : safeVersions;

  const sortedVersions = [...versionsToUse].sort((left, right) => {
    const getHighestMcVersion = (version) => {
      if (!version?.gameVersions || version.gameVersions.length === 0) {
        return [0, 0, 0];
      }

      const parsedVersions = version.gameVersions.map((gameVersion) => {
        const parts = String(gameVersion || '').split('.').map(Number);
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
      });

      parsedVersions.sort((a, b) => {
        if (a[0] !== b[0]) return b[0] - a[0];
        if (a[1] !== b[1]) return b[1] - a[1];
        return b[2] - a[2];
      });

      return parsedVersions[0];
    };

    const leftMcVersion = getHighestMcVersion(left);
    const rightMcVersion = getHighestMcVersion(right);

    if (leftMcVersion[0] !== rightMcVersion[0]) return rightMcVersion[0] - leftMcVersion[0];
    if (leftMcVersion[1] !== rightMcVersion[1]) return rightMcVersion[1] - leftMcVersion[1];
    if (leftMcVersion[2] !== rightMcVersion[2]) return rightMcVersion[2] - leftMcVersion[2];

    const leftDate = left?.datePublished ? new Date(left.datePublished).getTime() : 0;
    const rightDate = right?.datePublished ? new Date(right.datePublished).getTime() : 0;
    return rightDate - leftDate;
  });

  return sortedVersions[0] || null;
}

export function selectSearchCardVersionForFilter(versions = [], filterMinecraftVersion = '') {
  const safeVersions = toSafeVersionList(versions);
  if (safeVersions.length === 0) {
    return null;
  }

  if (!filterMinecraftVersion || filterMinecraftVersion === '') {
    return selectBestSearchCardVersion(safeVersions);
  }

  const exactMatches = safeVersions.filter((version) =>
    Array.isArray(version?.gameVersions) && version.gameVersions.includes(filterMinecraftVersion)
  );
  const exactPick = pickPreferredSearchCardVersion(exactMatches);
  if (exactPick) {
    return exactPick;
  }

  const mcVersionParts = String(filterMinecraftVersion || '').split('.');
  if (mcVersionParts.length >= 2 && mcVersionParts[0] === '1') {
    const majorMinorPrefix = `${mcVersionParts[0]}.${mcVersionParts[1]}`;

    const likelyCompatible = safeVersions.filter((version) => {
      if (!Array.isArray(version?.gameVersions)) {
        return false;
      }

      return version.gameVersions.some((gameVersion) => {
        if (!gameVersion) {
          return false;
        }

        if (gameVersion.startsWith(majorMinorPrefix)) return true;
        if (gameVersion.includes(majorMinorPrefix)) return true;

        const gameVersionParts = String(gameVersion).split('.');
        if (gameVersionParts.length >= 2 && gameVersionParts[0] === mcVersionParts[0]) {
          const gameMinor = parseInt(gameVersionParts[1], 10);
          const targetMinor = parseInt(mcVersionParts[1], 10);
          return Math.abs(gameMinor - targetMinor) <= 2;
        }

        return false;
      });
    });

    const likelyPick = pickPreferredSearchCardVersion(likelyCompatible);
    if (likelyPick) {
      return likelyPick;
    }
  }

  return selectBestSearchCardVersion(safeVersions);
}

export function buildSearchCardVersionSelectionContext({
  modId = '',
  activeContentType = 'mods',
  filterMinecraftVersion = '',
  installedVersionId = '',
  versions = []
} = {}) {
  const safeVersions = toSafeVersionList(versions);
  const firstVersionId = safeVersions[0]?.id || '';
  const lastVersionId = safeVersions[safeVersions.length - 1]?.id || '';

  return [
    modId || '',
    activeContentType || 'mods',
    filterMinecraftVersion || 'all',
    installedVersionId || '',
    safeVersions.length,
    firstVersionId,
    lastVersionId
  ].join('::');
}

export function resolveSearchCardVersionSelection({
  versions = [],
  filterMinecraftVersion = '',
  installedVersionId = '',
  isInstalled = false,
  currentSelectedVersionId = '',
  manualSelectionContextKey = '',
  selectionContextKey = ''
} = {}) {
  const safeVersions = toSafeVersionList(versions);
  const hasVersion = (versionId) => (
    Boolean(versionId) && safeVersions.some((version) => version.id === versionId)
  );

  if (safeVersions.length === 0) {
    return {
      selectedVersionId: currentSelectedVersionId || '',
      manualSelectionContextKey: manualSelectionContextKey || ''
    };
  }

  const installedVersionAvailable = isInstalled && hasVersion(installedVersionId)
    ? installedVersionId
    : '';
  const preferredVersion = installedVersionAvailable
    ? safeVersions.find((version) => version.id === installedVersionAvailable) || null
    : selectSearchCardVersionForFilter(safeVersions, filterMinecraftVersion);
  const preferredVersionId = preferredVersion?.id || '';
  const currentVersionStillAvailable = !currentSelectedVersionId || hasVersion(currentSelectedVersionId);
  const manualSelectionStillValid = (
    Boolean(currentSelectedVersionId)
    && manualSelectionContextKey === selectionContextKey
    && hasVersion(currentSelectedVersionId)
  );

  if (!currentVersionStillAvailable) {
    return {
      selectedVersionId: preferredVersionId,
      manualSelectionContextKey: ''
    };
  }

  if (isInstalled && installedVersionAvailable && currentSelectedVersionId !== installedVersionAvailable) {
    return {
      selectedVersionId: installedVersionAvailable,
      manualSelectionContextKey: ''
    };
  }

  if (!currentSelectedVersionId && preferredVersionId) {
    return {
      selectedVersionId: preferredVersionId,
      manualSelectionContextKey: ''
    };
  }

  if (!isInstalled && !manualSelectionStillValid && preferredVersionId && currentSelectedVersionId !== preferredVersionId) {
    return {
      selectedVersionId: preferredVersionId,
      manualSelectionContextKey: ''
    };
  }

  return {
    selectedVersionId: currentSelectedVersionId || preferredVersionId,
    manualSelectionContextKey: manualSelectionStillValid ? manualSelectionContextKey : ''
  };
}
