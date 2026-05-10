export interface CreateOptions {
  name: string;
  languages: string[];
  services: string[];
  postgresUrl?: string;
}

export interface StackFile {
  name: string;
  createdAt: string;
  monocerosCliVersion: string;
  languages: string[];
  services: string[];
  externalServices: Record<string, string>;
}
