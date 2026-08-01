const GIB = 1024n * 1024n * 1024n;
const MIB = 1024n * 1024n;

const ARCHIVE_LIMITS = Object.freeze({
  version: 1,
  maxArtifactSetBytes: (16n * GIB).toString(),
  maxArchiveEntries: 250000,
  maxExpandedBytes: (64n * GIB).toString(),
  maxFileExpandedBytes: (16n * GIB).toString(),
  maxPathDepth: 64,
  maxNormalizedPathLength: 1024,
  maxTechnicalStdoutBytes: (64n * MIB).toString(),
  maxTechnicalStderrBytes: (8n * MIB).toString(),
  maxListTestMs: 5 * 60 * 1000,
  maxExtractionMs: 60 * 60 * 1000,
  maxChildJobMemoryBytes: (2n * GIB).toString(),
  maxPerEntryCompressionRatio: 1000,
  minPerEntryRatioExpandedBytes: (64n * MIB).toString(),
  maxAggregateCompressionRatio: 1000,
  minAggregateRatioExpandedBytes: (256n * MIB).toString(),
  minPreflightReserveBytes: (2n * GIB).toString(),
  preflightReservePercent: 10
});

function parseNonNegativeBytes(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Byte value must be a non-negative decimal string');
  return BigInt(value);
}

function computePreflightReserve(plannedFootprint) {
  const bytes = parseNonNegativeBytes(plannedFootprint);
  const percentage = (bytes + 9n) / 10n;
  const minimum = BigInt(ARCHIVE_LIMITS.minPreflightReserveBytes);
  return (percentage > minimum ? percentage : minimum).toString();
}

module.exports = { ARCHIVE_LIMITS, computePreflightReserve, parseNonNegativeBytes };
