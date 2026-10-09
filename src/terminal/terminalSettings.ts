import type { ConfigSection } from '../core/ports';
import type { ServerConfig } from '../config/schema';

/**
 * Resolved sshManager.* terminal settings. Field-for-field identical to the
 * interface previously living in src/webview/TerminalPanel.ts.
 */
export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
  semanticHighlight: boolean;
  idleDisconnectMinutes: number;
  zebraStripes: boolean;
  sessionLogDirectory: string;
  encoding: string;
}

/**
 * Reads the sshManager.* configuration section (caller passes
 * `platform().config.getSection('sshManager')`) and resolves the terminal
 * settings with their defaults. Moved out of src/webview/TerminalPanel.ts so
 * domain code can consume it without a webview dependency.
 */
export function resolveTerminalSettings(
  configuration: ConfigSection,
  server?: Pick<ServerConfig, 'encoding'>
): TerminalSettings {
  return {
    scrollback: configuration.get('scrollback', 10000),
    fontSize: configuration.get('terminalFontSize', 14),
    fontFamily: configuration.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace'),
    semanticHighlight: configuration.get('semanticHighlight', true),
    idleDisconnectMinutes: configuration.get('idleDisconnectMinutes', 60),
    zebraStripes: configuration.get('zebraStripes', false),
    sessionLogDirectory: configuration.get('sessionLogDirectory', ''),
    encoding: server?.encoding ?? 'utf-8'
  };
}