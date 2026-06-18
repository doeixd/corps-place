# Database Division Corrections - Summary

## Overview

Fixed incorrectly classified corps divisions in the database caused by mixed-division tables on DCI website recap pages.

## Problem Description

The DCI website sometimes displays multiple divisions in a single table labeled with only one division name. For example, the World Championship Prelims page has a table labeled "World Class" that contains both World Class and Open Class corps.

The original scraper trusted the table header and assigned all corps in that table as "World Class", causing misclassification of Open Class corps.

## Seasons Fixed

### 2024 Season
- **Total corrections**: 33 entries
- **World/Open Class issues**: 10 Open Class corps incorrectly marked as World Class
  - 7th Regiment, Blue Devils B, Colt Cadets, Columbians, Gold, Les Stentors, Raiders, River City Rhythm, Spartans, The Battalion
- **All-Age variations**: 11 corps with inconsistent All-Age sub-class labels
- **Key competition**: 2024 World Championship Prelims

### 2023 Season
- **Total corrections**: 15 entries
- **World/Open Class issues**: 11 Open Class corps incorrectly marked as World Class
  - 7th Regiment, Colt Cadets, Columbians, Gold, Guardians, Les Stentors, Raiders, River City Rhythm, Spartans, Southwind, The Battalion
- **Key competition**: 2023 World Championship Prelims

### 2022 Season
- **Total corrections**: 20 entries
- **World/Open Class issues**: 14 Open Class corps incorrectly marked as World Class
- **International Class**: 1 corps (Calgary Stampede Showband) incorrectly marked as World Class
- **Key competition**: 2022 World Championship Prelims

### 2019 Season
- **Total corrections**: 17 entries
- **World/Open Class issues**: 14 Open Class corps incorrectly marked as World Class
- **Key competition**: 2019 World Championship Prelims

### Seasons with No Issues
- **2021**: 0 corrections needed
- **2020**: 0 corrections needed (season was cancelled due to COVID-19)

## Total Impact

- **4 seasons corrected**
- **85 database entries updated**
- **All corrections verified**

## Fix Strategy

The fix script uses a "majority vote" approach:

1. **Query all competitions** for a given corps in that season
2. **Count occurrences** of each division
3. **Primary division** = most frequent division for that corps
4. **Update outliers** to match the primary division

This approach is robust because:
- Most corps compete in their correct division throughout the season
- Only 1-2 events per season have mixed-division tables
- The majority accurately represents the corps' actual division

## Verification

After each season fix:
```sql
SELECT corps_name, division_name
FROM corps_scores
WHERE competition_slug = '2024-dci-world-championship-prelims'
  AND corps_name = '7th Regiment';
```

**Before fix**: `7th Regiment | World Class` ❌
**After fix**: `7th Regiment | Open Class` ✅

## Prevention

The parser has been updated with a **division lookup system** to prevent this issue in future scrapes:

1. Builds a `CorpsDivisionMap` from existing data before scraping
2. Looks up each corps' actual division during parsing
3. Overrides table header when there's a mismatch
4. Falls back to previous season if current season has no data

See `DIVISION_LOOKUP_FIX.md` for technical details.

## How to Run

Fix all seasons:
```bash
# Dry run to preview changes
npx tsx scripts/fixIncorrectDivisions.ts --season=2024 --dryRun

# Apply fixes
npx tsx scripts/fixIncorrectDivisions.ts --season=2024
npx tsx scripts/fixIncorrectDivisions.ts --season=2023
npx tsx scripts/fixIncorrectDivisions.ts --season=2022
npx tsx scripts/fixIncorrectDivisions.ts --season=2019
```

## Files

- **Fix script**: `scripts/fixIncorrectDivisions.ts`
- **Parser updates**: `src/websiteRecap.ts`, `src/websiteScraper.ts`
- **Integration**: Works with `scrapeAllData` and all scraping functions
