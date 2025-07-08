const modApiService = require('../../services/mod-api-service.cjs');
const { readModMetadata } = require('./mod-handler-utils.cjs');
const { modMatchingManager } = require('../mod-utils/mod-matching-manager.cjs');
const path = require('path');
const fs = require('fs');

function createModrinthMatchingHandlers() {
  return {
    // Search Modrinth for potential matches for a manually added mod
    'search-modrinth-matches': async (_event, { modPath, modName, modVersion }) => {
      try {
        // Extract mod metadata first
        let metadata = null;
        if (modPath && fs.existsSync(modPath)) {
          try {
            metadata = await readModMetadata(modPath);
          } catch (error) {
            console.warn('Failed to read mod metadata:', error.message);
          }
        }

        // Use metadata name if available, otherwise use provided name
        const searchName = metadata?.name || modName || path.basename(modPath, '.jar');
        const searchVersion = metadata?.version || modVersion;

        // First, try searching by exact name
        let searchResults = await modApiService.searchModrinthMods({
          query: searchName,
          loader: 'fabric', // Default to fabric, could be made configurable
          version: null,
          page: 1,
          limit: 10,
          sortBy: 'relevance'
        });

        let matches = [];

        if (searchResults.mods && searchResults.mods.length > 0) {
          // Score matches based on name similarity and other factors
          for (const mod of searchResults.mods) {
            // Convert to expected format for scoring
            const modrinthMod = {
              project_id: mod.id,
              slug: mod.slug,
              title: mod.name,
              description: mod.description,
              downloads: mod.downloads,
              author: mod.author
            };
            
            const score = calculateMatchScore(searchName, searchVersion, modrinthMod, metadata);
            
            if (score > 0.3) { // Only include reasonably good matches
              matches.push({
                ...modrinthMod,
                matchScore: score,
                matchReasons: getMatchReasons(searchName, searchVersion, modrinthMod, metadata)
              });
            }
          }

          // Sort by match score
          matches.sort((a, b) => b.matchScore - a.matchScore);
          
          // Fetch versions for top matches to enable version-aware matching
          if (matches.length > 0) {
            const versionsPromises = matches.slice(0, 3).map(async (match) => {
              try {
                const versions = await modApiService.getModrinthVersions(
                  match.project_id,
                  'fabric', // Default to fabric, could be made configurable
                  null, // Get all versions
                  false // Don't load latest only
                );
                
                return {
                  ...match,
                  availableVersions: versions || [],
                  hasMatchingVersion: searchVersion ? 
                    checkVersionMatch(searchVersion, versions || []) : false
                };
              } catch (error) {
                console.warn(`⚠️ Failed to fetch versions for ${match.title}:`, error.message);
                return {
                  ...match,
                  availableVersions: [],
                  hasMatchingVersion: false
                };
              }
            });
            
            // Wait for all version fetches to complete
            const matchesWithVersions = await Promise.all(versionsPromises);
            
            // Update matches array with version info
            matches = [
              ...matchesWithVersions,
              ...matches.slice(3) // Keep remaining matches without version info
            ];
          }
        } else {
          // No search results returned from Modrinth
        }

        // If no good matches found with exact name, try a broader search
        if (matches.length === 0 && searchName) {
          
          // Strategy 1: Try first 2-3 meaningful words
          const words = searchName.toLowerCase().split(/[\s\-_]+/).filter(w => 
            w.length > 2 && !['the', 'mod', 'for', 'and', 'with', 'but', 'new', 'old', 'api', 'fabric', 'forge', 'mc'].includes(w)
          );
          
          const searchStrategies = [];
          
          if (words.length >= 2) {
            searchStrategies.push(words.slice(0, 2).join(' ')); // First 2 words
            if (words.length >= 3) {
              searchStrategies.push(words.slice(0, 3).join(' ')); // First 3 words
            }
          }
          
          // Strategy 2: Also try cleaned name
          const cleanedName = cleanModName(searchName);
          if (cleanedName !== searchName && !searchStrategies.includes(cleanedName)) {
            searchStrategies.push(cleanedName);
          }
          
          // Strategy 3: Try just the first word if it's meaningful
          if (words.length > 0 && words[0].length > 4) {
            searchStrategies.push(words[0]);
          }

          for (const strategy of searchStrategies) {
            const broaderResults = await modApiService.searchModrinthMods({
              query: strategy,
              loader: 'fabric',
              version: null,
              page: 1,
              limit: 10,
              sortBy: 'relevance'
            });

            if (broaderResults.mods && broaderResults.mods.length > 0) {
              for (const mod of broaderResults.mods) {
                // Convert back to expected format for scoring
                const modrinthMod = {
                  project_id: mod.id,
                  slug: mod.slug,
                  title: mod.name,
                  description: mod.description,
                  downloads: mod.downloads,
                  author: mod.author
                };
                
                const score = calculateMatchScore(searchName, searchVersion, modrinthMod, metadata);
                if (score > 0.15) { // Even lower threshold for broad search
                  matches.push({
                    ...modrinthMod,
                    matchScore: score,
                    matchReasons: getMatchReasons(searchName, searchVersion, modrinthMod, metadata)
                  });
                }
              }

              // Sort by match score
              matches.sort((a, b) => b.matchScore - a.matchScore);
              
              // If we found some good matches, break
              if (matches.length > 0) {
                break;
              }
            }
          }
        }

        return {
          success: true,
          matches: matches.slice(0, 5), // Return top 5 matches
          searchedName: searchName,
          searchedVersion: searchVersion,
          metadata,
          debugInfo: {
            totalHits: searchResults.total_hits || 0,
            processedHits: searchResults.hits ? searchResults.hits.length : 0,
            goodMatches: matches.length
          }
        };

      } catch (error) {
        console.error('Error searching Modrinth matches:', error);
        return {
          success: false,
          error: error.message,
          matches: []
        };
      }
    },

    // Get detailed information about a specific Modrinth project for confirmation
    'get-modrinth-project-details': async (_event, { projectId }) => {
      try {
        const projectInfo = await modApiService.getModrinthProjectInfo(projectId);
        const versions = await modApiService.getModrinthVersions(projectId, 'fabric', null, false);

        return {
          success: true,
          project: projectInfo,
          versions: versions.slice(0, 10) // Return latest 10 versions
        };
      } catch (error) {
        console.error('Error getting Modrinth project details:', error);
        return {
          success: false,
          error: error.message
        };
      }
    },

    // Search Modrinth with custom query for manual matching
    'search-modrinth-manual': async (_event, { query, loader = 'fabric', limit = 20 }) => {
      try {
        const results = await modApiService.searchModrinthMods({
          query,
          loader,
          version: null,
          page: 1,
          limit,
          sortBy: 'relevance'
        });

        // Convert the processed mods back to the format expected by the frontend
        const formattedResults = results.mods.map(mod => ({
          project_id: mod.id,
          slug: mod.slug,
          title: mod.name,
          description: mod.description,
          icon_url: mod.iconUrl,
          downloads: mod.downloads,
          follows: mod.followers,
          categories: mod.categories,
          author: mod.author,
          client_side: mod.clientSide ? 'required' : 'optional',
          server_side: mod.serverSide ? 'required' : 'optional',
          date_modified: mod.lastUpdated
        }));

        return {
          success: true,
          results: formattedResults,
          total: results.pagination.totalResults
        };
      } catch (error) {
        console.error('Error in manual Modrinth search:', error);
        return {
          success: false,
          error: error.message,
          results: []
        };
      }
    },

    // Set pending confirmation for a mod
    'set-mod-pending-confirmation': async (_event, { fileName, matches, metadata, searchedName, searchedVersion }) => {
      try {
        modMatchingManager.setPendingConfirmation(fileName, {
          matches,
          metadata,
          searchedName,
          searchedVersion
        });

        return { success: true };
      } catch (error) {
        console.error('Error setting pending confirmation:', error);
        return { success: false, error: error.message };
      }
    },

    // Get pending confirmation for a mod
    'get-mod-pending-confirmation': async (_event, { fileName }) => {
      try {
        const pending = modMatchingManager.getPendingConfirmation(fileName);
        return { success: true, pending };
      } catch (error) {
        console.error('Error getting pending confirmation:', error);
        return { success: false, error: error.message, pending: null };
      }
    },

    // Get all pending confirmations
    'get-all-pending-confirmations': async () => {
      try {
        const pending = modMatchingManager.getAllPendingConfirmations();
        return { success: true, pending };
      } catch (error) {
        console.error('Error getting all pending confirmations:', error);
        return { success: false, error: error.message, pending: [] };
      }
    },

    // Get all confirmed matches
    'get-all-confirmed-matches': async () => {
      try {
        const confirmed = modMatchingManager.getAllConfirmedMatches();
        return { success: true, confirmed };
      } catch (error) {
        console.error('Error getting all confirmed matches:', error);
        return { success: false, error: error.message, confirmed: [] };
      }
    },

    // Confirm a Modrinth match
    'confirm-modrinth-match': async (_event, { fileName, projectId, modrinthData }) => {
      try {
        modMatchingManager.confirmMatch(fileName, projectId, modrinthData);
        return { success: true };
      } catch (error) {
        console.error('Error confirming Modrinth match:', error);
        return { success: false, error: error.message };
      }
    },

    // Reject a Modrinth match
    'reject-modrinth-match': async (_event, { fileName, reason = 'User rejected' }) => {
      try {
        modMatchingManager.rejectMatch(fileName, reason);
        return { success: true };
      } catch (error) {
        console.error('Error rejecting Modrinth match:', error);
        return { success: false, error: error.message };
      }
    },

    // Get mod matching status
    'get-mod-matching-status': async (_event, { fileName }) => {
      try {
        const status = modMatchingManager.getModStatus(fileName);
        const confirmedMatch = modMatchingManager.getConfirmedMatch(fileName);
        const pendingConfirmation = modMatchingManager.getPendingConfirmation(fileName);

        return {
          success: true,
          status,
          confirmedMatch,
          pendingConfirmation
        };
      } catch (error) {
        console.error('Error getting mod matching status:', error);
        return {
          success: false,
          error: error.message,
          status: 'unknown'
        };
      }
    },

    // Clear mod matching data (when mod is deleted)
    'clear-mod-matching-data': async (_event, { fileName }) => {
      try {
        modMatchingManager.clearModData(fileName);
        return { success: true };
      } catch (error) {
        console.error('Error clearing mod matching data:', error);
        return { success: false, error: error.message };
      }
    },

    // Reset matching decision for a mod
    'reset-matching-decision': async (_event, { fileName }) => {
      try {
        modMatchingManager.clearModData(fileName);
        return { success: true };
      } catch (error) {
        console.error('Error resetting matching decision:', error);
        return { success: false, error: error.message };
      }
    }
  };
}

// Helper function to calculate match score between local mod and Modrinth mod
function calculateMatchScore(localName, localVersion, modrinthMod, metadata) {
  let score = 0;
  const reasons = [];

  if (!localName || !modrinthMod) return 0;

  const localNameLower = localName.toLowerCase();
  const modrinthNameLower = modrinthMod.title.toLowerCase();
  const modrinthSlugLower = modrinthMod.slug.toLowerCase();

  // Exact name match (highest score)
  if (localNameLower === modrinthNameLower) {
    score += 0.8;
    reasons.push('Exact name match');
  }
  // Name contains the other
  else if (localNameLower.includes(modrinthNameLower) || modrinthNameLower.includes(localNameLower)) {
    score += 0.6;
    reasons.push('Name similarity');
  }
  // Slug match
  else if (localNameLower === modrinthSlugLower || localNameLower.includes(modrinthSlugLower)) {
    score += 0.5;
    reasons.push('Slug similarity');
  }
  // Partial name match
  else {
    const words = localNameLower.split(/[\s\-_]+/);
    const modrinthWords = modrinthNameLower.split(/[\s\-_]+/);
    let commonWords = 0;
    
    for (const word of words) {
      if (word.length > 2 && modrinthWords.some(mw => mw.includes(word) || word.includes(mw))) {
        commonWords++;
      }
    }
    
    if (commonWords > 0) {
      score += (commonWords / Math.max(words.length, modrinthWords.length)) * 0.4;
      reasons.push(`${commonWords} common words`);
    }
  }

  // Version match bonus
  if (localVersion && modrinthMod.versions && modrinthMod.versions.includes(localVersion)) {
    score += 0.2;
    reasons.push('Version available');
  }

  // Author match bonus (if we have metadata)
  if (metadata && metadata.authors && metadata.authors.length > 0 && modrinthMod.author) {
    const localAuthors = metadata.authors.map(a => a.toLowerCase());
    const modrinthAuthor = modrinthMod.author.toLowerCase();
    
    if (localAuthors.some(author => author === modrinthAuthor)) {
      score += 0.3;
      reasons.push('Author match');
    }
  }

  // Download count bonus (popular mods are more likely to be correct)
  if (modrinthMod.downloads > 10000) {
    score += 0.1;
  }

  return Math.min(score, 1.0); // Cap at 1.0
}

// Helper function to get human-readable match reasons
function getMatchReasons(localName, localVersion, modrinthMod, metadata) {
  const reasons = [];
  
  if (!localName || !modrinthMod) return reasons;

  const localNameLower = localName.toLowerCase();
  const modrinthNameLower = modrinthMod.title.toLowerCase();
  const modrinthSlugLower = modrinthMod.slug.toLowerCase();

  if (localNameLower === modrinthNameLower) {
    reasons.push('Exact name match');
  } else if (localNameLower.includes(modrinthNameLower) || modrinthNameLower.includes(localNameLower)) {
    reasons.push('Similar name');
  } else if (localNameLower === modrinthSlugLower || localNameLower.includes(modrinthSlugLower)) {
    reasons.push('Matches project slug');
  }

  if (localVersion && modrinthMod.versions && modrinthMod.versions.includes(localVersion)) {
    reasons.push('Version available');
  }

  if (metadata && metadata.authors && metadata.authors.length > 0 && modrinthMod.author) {
    const localAuthors = metadata.authors.map(a => a.toLowerCase());
    const modrinthAuthor = modrinthMod.author.toLowerCase();
    
    if (localAuthors.some(author => author === modrinthAuthor)) {
      reasons.push('Same author');
    }
  }

  if (modrinthMod.downloads > 100000) {
    reasons.push('Popular mod');
  }

  return reasons;
}

// Helper function to clean mod name for broader search
function cleanModName(name) {
  if (!name) return '';
  
  // Remove common suffixes and version numbers
  let cleaned = name
    .replace(/[-_\s]*\d+\.\d+[.\d]*[-\w]*$/i, '') // Remove version numbers
    .replace(/[-_\s]*(fabric|forge|quilt|mod|api)$/i, '') // Remove loader/type suffixes
    .replace(/[-_\s]*mc\d+[.\d]*$/i, '') // Remove minecraft version
    .replace(/[-_\s]*(client|server)$/i, '') // Remove side indicators
    .replace(/[-_\s]*(fix|patch|update)$/i, '') // Remove common suffixes that might not be in mod titles
    .trim();

  // If we removed everything, return the original
  if (!cleaned) return name;

  // Try to extract meaningful words and remove very common ones
  const words = cleaned.split(/[\s\-_]+/).filter(w => {
    const word = w.toLowerCase();
    return w.length > 2 && 
           !['the', 'mod', 'for', 'and', 'with', 'but', 'new', 'old'].includes(word);
  });

  if (words.length > 0) {
    // Return the first meaningful word, or first two if the first is very short
    if (words[0].length <= 3 && words[1]) {
      return words.slice(0, 2).join(' ');
    }
    return words[0];
  }

  return cleaned;
}

// Helper function to check if a version matches any available versions
function checkVersionMatch(searchVersion, availableVersions) {
  if (!searchVersion || !availableVersions || availableVersions.length === 0) {
    return false;
  }
  
  const normalizeVersion = (version) => {
    return version
      .toLowerCase()
      .replace(/[-_+](fabric|forge|quilt|neoforge).*$/i, '') // Remove loader suffixes
      .replace(/^v/i, '') // Remove 'v' prefix
      .trim();
  };
  
  const normalizedSearch = normalizeVersion(searchVersion);
  
  return availableVersions.some(v => {
    const versionStr = v.versionNumber || v.version_number || v.name || '';
    const normalizedAvailable = normalizeVersion(versionStr);
    
    // Exact match after normalization
    if (normalizedSearch === normalizedAvailable) {
      return true;
    }
    
    // Check if search version is contained in available version
    // (e.g., "2.0.0" matches "2.0.0-fabric")
    if (normalizedAvailable.startsWith(normalizedSearch + '-') || 
        normalizedAvailable.startsWith(normalizedSearch + '+') || 
        normalizedAvailable.startsWith(normalizedSearch + '_')) {
      return true;
    }
    
    // Check if available version is contained in search version
    // (e.g., "2.0.0-fabric" search matches "2.0.0" available)
    if (normalizedSearch.startsWith(normalizedAvailable + '-') || 
        normalizedSearch.startsWith(normalizedAvailable + '+') || 
        normalizedSearch.startsWith(normalizedAvailable + '_')) {
      return true;
    }
    
    return false;
  });
}

module.exports = { createModrinthMatchingHandlers };
