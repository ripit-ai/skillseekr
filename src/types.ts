export type Auth =
  | { type: 'none' }
  | { type: 'github_token'; env_var: string }
  | { type: 'gh_cli' }
  | { type: 'bearer'; env_var: string }
  | { type: 'basic'; username_env_var: string; password_env_var: string };

export interface GithubEntry {
  type: 'github'; owner: string; repo: string; skills_dir: string; ref: string;
  auth: Auth; cache_enabled: boolean; description?: string; instructions?: string;
}
export interface HttpEntry {
  type: 'http'; url: string; skill_name: string;
  auth: Auth; cache_enabled: boolean; description?: string; instructions?: string;
}
export interface GithubRegistryEntry {
  type: 'github-registry'; owner: string; repo: string; ref: string; path: string;
  auth: Auth; cache_enabled: boolean; policy: boolean; description?: string;
}
export interface HttpRegistryEntry {
  type: 'http-registry'; url: string;
  auth: Auth; cache_enabled: boolean; policy: boolean; description?: string;
}
export type SourceEntry = GithubEntry | HttpEntry;
export type IncludeEntry = GithubRegistryEntry | HttpRegistryEntry;
export type RegistryEntry = SourceEntry | IncludeEntry;

export interface Problem {
  level: 'error' | 'warning'; code: string; message: string;
  registry?: string; via?: string[]; file?: string;
}
export interface RegistriesFile {
  registries: Array<[name: string, entry: RegistryEntry]>;
  problems: Problem[];
}
export interface Config extends RegistriesFile { path: string; exists: boolean; libraryDir: string /* absolute */ }
