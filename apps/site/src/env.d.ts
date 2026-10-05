/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly BUILD_VERSION?: string;
  /** True when this build includes draft guides (astro.config.mjs). */
  readonly GUIDE_DRAFTS?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
