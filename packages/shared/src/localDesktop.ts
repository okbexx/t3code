/** Local packaging identity. Keep this commit out of upstream contribution branches. */
export const localDesktop = {
  name: "T3 Code Local",
  appId: "com.okbexx.t3code.local",
  homeDirectory: ".t3-local",
  electronProfile: "t3code-local-v2",
  developmentProfile: "t3code-local-dev",
  scheme: "t3code-local",
  developmentScheme: "t3code-local-dev",
  backendPort: 13774,
} as const;
