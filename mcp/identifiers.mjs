export const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const fullCommitPattern = /^[a-f0-9]{40}$/i;

export function isPluginId(value) {
  return pluginIdPattern.test(String(value || ""));
}

export function isFullCommit(value) {
  return fullCommitPattern.test(String(value || ""));
}
