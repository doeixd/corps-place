/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BROWSERBASE_API_KEY?: string;
  readonly SITE_BASE_PATH?: string;
  readonly DCI_API_PROXY_DISABLED?: string;
  readonly DCI_API_PROXY_TARGET?: string;
  readonly DCI_API_PROXY_PREFIX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
