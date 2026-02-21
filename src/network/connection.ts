import type { SendOptions } from '../client';

export type ConnectionSendOptions = Required<Pick<SendOptions, 'timeout'>> &
  Pick<SendOptions, 'useSharedSocket' | 'sharedSocketTimeout'>;

export interface DeviceConnection {
  send(
    payload: string,
    port: number,
    host: string,
    options: ConnectionSendOptions,
  ): Promise<string>;
  close(): void;
}

