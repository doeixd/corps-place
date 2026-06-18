# Division Lookup Fix for Mixed-Division Tables

## Problem

The DCI website sometimes has **mixed-division tables** where Open Class corps appear in a table labeled "World Class". For example, the 2024 World Championship Prelims page has:

- **Table header**: "World Class"
- **Actual corps**: Mix of World Class AND Open Class corps
- **Issue**: 7th Regiment, Colt Cadets, Gold, Les Stentors, Raiders, etc. (all Open Class) were being incorrectly classified as "World Class"

## Root Cause

The original parser inferred division from the table section header:
```typescript
const divisionName = inferDivisionName(classTable.className); // Uses "World Class" from header
```

This worked for properly separated tables but failed for mixed-division tables.

## Solution

Implemented a **corps division lookup system** that:

1. **Queries the database** for each corps' primary division in that season
2. **Primary division** = most frequent division that corps competed in during the season
3. **Overrides the table header** when there's a mismatch
4. **Falls back** to table header if corps isn't in the map

### Implementation Details

**New function**: `buildCorpsDivisionMapForSeason()`
- Queries `corps_scores` table for the season
- Groups by corps name and division
- Takes most frequent division as primary
- Falls back to previous season if current season has no data (handles new seasons)

**Updated function**: `buildCorpsScoresFromWebsiteRecap()`
- Accepts optional `corpsDivisionMap` parameter
- Looks up each corps in the map
- Uses looked-up division if found, otherwise uses table header

**Updated scraper**: `scrapeWebsiteRecapsForSeason()`
- Builds division map once per season (efficient)
- Passes map to all recap parsing operations

## Test Results

### Without Division Lookup (Old Behavior)
```
2024 World Championship Prelims:
  Total corps: 31
  Incorrectly classified: 10

  ❌ Spartans: assigned "World Class", should be "Open Class"
  ❌ Blue Devils B: assigned "World Class", should be "Open Class"
  ❌ Gold: assigned "World Class", should be "Open Class"
  ❌ The Battalion: assigned "World Class", should be "Open Class"
  ❌ Columbians: assigned "World Class", should be "Open Class"
  ❌ River City Rhythm: assigned "World Class", should be "Open Class"
  ❌ Raiders: assigned "World Class", should be "Open Class"
  ❌ Colt Cadets: assigned "World Class", should be "Open Class"
  ❌ 7th Regiment: assigned "World Class", should be "Open Class"
  ❌ Les Stentors: assigned "World Class", should be "Open Class"
```

### With Division Lookup (New Behavior)
```
2024 World Championship Prelims:
  Total corps: 31
  Incorrectly classified: 0

  ✅ All corps correctly classified!

  Open Class: 10 corps (Spartans, Blue Devils B, Gold, etc.)
  World Class: 21 corps (Bluecoats, Blue Devils, Boston Crusaders, etc.)
```

## Files Modified

1. **src/websiteRecap.ts**
   - Added `CorpsDivisionMap` interface
   - Updated `buildCorpsScoresFromWebsiteRecap()` to accept and use division map

2. **src/websiteScraper.ts**
   - Added `buildCorpsDivisionMapForSeason()` function
   - Updated `scrapeWebsiteRecapsForSeason()` to build and pass division map
   - Updated `scrapeWebsiteRecapByEntry()` to receive division map

## Usage

The fix is automatic - no code changes required by users. When scraping:

```bash
npx tsx scripts/scrapeWebsiteRecaps.ts --season=2024
```

The scraper will:
1. Build corps division map from existing 2024 data
2. Use map to correctly classify all corps
3. Fall back to 2023 data if 2024 is empty (new season)

## Edge Cases Handled

1. **New season with no data**: Falls back to previous season's division map
2. **Corps name variations**: Normalizes to lowercase for lookup
3. **Missing corps in map**: Falls back to table header inference
4. **Multiple tables per page**: Each table still processes independently, but all use the same division map

## Database Query

The division map is built with:
```sql
SELECT
  corps_name,
  division_name,
  COUNT(*) as count
FROM corps_scores
WHERE competition_slug LIKE '2024-%'
GROUP BY corps_name, division_name
ORDER BY corps_name, count DESC
```

For each corps, we take the first row (highest count) as primary division.

## Verification

Run test script to verify:
```bash
npx tsx scripts/testDivisionLookup.ts
```

Expected output: ✅ All corps correctly classified with division lookup!
