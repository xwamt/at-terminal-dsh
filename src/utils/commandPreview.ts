import { copy } from '../i18n/copy';

export const COMMAND_PREVIEW_MAX_LINES = 20;
export const COMMAND_PREVIEW_MAX_CHARS = 800;

export function truncateCommandPreview(
  command: string,
  maxLines = COMMAND_PREVIEW_MAX_LINES,
  maxChars = COMMAND_PREVIEW_MAX_CHARS
): string {
  const totalChars = command.length;
  const totalLines = command.length === 0 ? 0 : command.split('\n').length;
  let preview = command;
  const lines = command.split('\n');
  if (lines.length > maxLines) {
    preview = lines.slice(0, maxLines).join('\n');
  }
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
  }
  if (preview !== command) {
    return `${preview}\n${copy('… (truncated, {chars} chars, {lines} lines)', {
      chars: totalChars,
      lines: totalLines
    })}`;
  }
  return command;
}

export function formatRemoteCommandConfirmMessage(options: {
  serverLabel: string;
  host: string;
  command: string;
  destructive: boolean;
  riskSummaries?: readonly string[];
}): string {
  const preview = truncateCommandPreview(options.command);
  const warning = options.destructive ? `\n\n${copy('Warning: this command appears destructive.')}` : '';
  const uniqueSummaries = [...new Set((options.riskSummaries ?? []).filter((summary) => summary.length > 0))];
  const risks = uniqueSummaries.length === 0 ? '' : `\n\n${uniqueSummaries.map((summary) => `- ${summary}`).join('\n')}`;
  const heading = copy('Run remote command on {server} ({host})?', {
    server: options.serverLabel,
    host: options.host
  });
  return `${heading}\n\n${preview}${warning}${risks}`;
}
