/** The app version (package builds stamp the same number into their file names). */
export const APP_VERSION = '0.9.0';

declare const __MWC_RELEASE__: boolean | undefined;
/**
 * True in packaged builds (installer, Docker image, update packages). Release builds trust only the
 * embedded HQ key, talk to the production HQ and never read development keys.
 */
export const IS_RELEASE: boolean = typeof __MWC_RELEASE__ !== 'undefined' && !!__MWC_RELEASE__;
