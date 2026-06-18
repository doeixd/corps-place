# Astro Starter Kit: Basics

```sh
npm create astro@latest -- --template basics
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
│   └── favicon.svg
├── src
│   ├── assets
│   │   └── astro.svg
│   ├── components
│   │   └── Welcome.astro
│   ├── layouts
│   │   └── Layout.astro
│   └── pages
│       └── index.astro
└── package.json
```

To learn more about the folder structure of an Astro project, refer to [our guide on project structure](https://docs.astro.build/en/basics/project-structure/).

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## ⚙️ Configuration

Host the site from a custom base path or forward API calls through the dev server by setting environment variables (e.g. in `.env`):

| Variable | Description | Default |
| :-- | :-- | :-- |
| `SITE_BASE_PATH` | Prefix the site should be served from (e.g. `/corps`). Leave unset for root hosting. | `/` |
| `DCI_API_PROXY_PREFIX` | Local path you will call from the browser that should proxy to the upstream DCI API. | `/dci-api` |
| `DCI_API_PROXY_TARGET` | Upstream API base URL. Override if you run your own gateway. | `https://api.dci.org/api/v1` |
| `DCI_API_PROXY_DISABLED` | Set to `true` to disable the proxy entirely. | `false` |

During `astro dev` and `astro preview`, requests to the proxy prefix are forwarded to the configured target with the prefix stripped, so `/dci-api/competitions` becomes `https://api.dci.org/api/v1/competitions`. When deploying behind a reverse proxy, set `SITE_BASE_PATH` to match the mount point so Astro emits the correct asset URLs.

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
