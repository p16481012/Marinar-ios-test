/** Native shell hint for presentation only. Server authorization never relies on this flag. */
export function isNativeIosApp(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as Window & { __MARINARA_IOS_APP__?: unknown }).__MARINARA_IOS_APP__ === true
  );
}

/** CLI login needs subprocesses that are not available in the embedded iOS runtime. */
export function isIosSupportedProvider(provider: string): boolean {
  return !isNativeIosApp() || !["openai_chatgpt", "claude_subscription", "grok_subscription"].includes(provider);
}
