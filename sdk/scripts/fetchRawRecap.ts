import fs from 'node:fs';

const slug = '2024-dci-world-championship-finals';
const url = `https://api.dci.org/api/v1/competitions/${slug}`;

async function main() {
  console.log(`Fetching raw recap from ${url}...`);
  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'corps-place-sdk/0.1'
    }
  });

  if (!response.ok) {
    console.error(`Failed to fetch: ${response.status} ${response.statusText}`);
    return;
  }

  const json = await response.json();
  const filePath = './recap_raw.json';
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2));
  console.log(`Raw recap saved to ${filePath}`);
}

main().catch(console.error);
