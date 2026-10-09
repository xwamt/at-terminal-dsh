import type { SftpWriteConfirmation, SftpWriteScope } from './SftpWriteAuthorizer';

export interface CommandConfirmationRequest {
  readonly serverLabel: string;
  readonly host: string;
  readonly command: string;
  readonly destructive: boolean;
  readonly riskSummaries: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AgentConfirmationPort {
  confirmCommand(request: CommandConfirmationRequest): Promise<boolean>;
  confirmSftpWrite(confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined>;
}
