import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../src/core/config.ts';
import { createDatabase, initialize } from '../src/core/database.ts';
import { start } from '../src/core/lifespan.ts';
import { createApp } from '../src/factory.ts';

vi.mock('../src/core/config.ts', () => ({ resolveDatabaseUrl: vi.fn() }));
vi.mock('../src/core/database.ts', () => ({ createDatabase: vi.fn(), initialize: vi.fn() }));
vi.mock('../src/factory.ts', () => ({ createApp: vi.fn() }));

class FakeServer extends EventEmitter {
  close = vi.fn((callback: () => void) => callback());
  address() {
    return { port: 8123 };
  }
}

function setup({ listenError }: { listenError?: Error } = {}) {
  const database = { $connect: vi.fn().mockResolvedValue(undefined), $disconnect: vi.fn().mockResolvedValue(undefined) };
  const server = new FakeServer();
  const app = {
    listen: vi.fn((_port: number, _host: string, onListening: () => void) => {
      queueMicrotask(() => (listenError ? server.emit('error', listenError) : onListening()));
      return server;
    }),
  };
  vi.mocked(resolveDatabaseUrl).mockReturnValue('postgresql://taskly:secret@db:5432/taskly');
  vi.mocked(createDatabase).mockReturnValue(database as unknown as ReturnType<typeof createDatabase>);
  vi.mocked(initialize).mockResolvedValue(undefined);
  vi.mocked(createApp).mockReturnValue(app as unknown as ReturnType<typeof createApp>);
  const handlers: Record<string, () => void> = {};
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
    handlers[event] = handler;
    return process;
  }) as typeof process.once);
  return { database, server, app, handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('start', () => {
  it('connects, prepares the schema, and listens on the configured port', async () => {
    vi.stubEnv('API_PORT', '8123');
    const { database, server, app } = setup();
    await expect(start()).resolves.toEqual({ server, database });
    expect(createDatabase).toHaveBeenCalledWith('postgresql://taskly:secret@db:5432/taskly');
    expect(database.$connect).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith(database);
    expect(createApp).toHaveBeenCalledWith(database);
    expect(app.listen).toHaveBeenCalledWith(8123, '0.0.0.0', expect.any(Function));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('8123'));
  });

  it('listens on port 8000 when API_PORT is not set', async () => {
    vi.stubEnv('API_PORT', '');
    const { app } = setup();
    await start();
    expect(app.listen).toHaveBeenCalledWith(8000, '0.0.0.0', expect.any(Function));
  });

  it('closes the server and disconnects on SIGTERM and SIGINT', async () => {
    const { database, server, handlers } = setup();
    await start();
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.SIGTERM();
    expect(server.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(database.$disconnect).toHaveBeenCalledOnce());
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a failed disconnect during shutdown with a failing exit code', async () => {
    const { database, handlers } = setup();
    database.$disconnect.mockRejectedValueOnce(new Error('connection lost'));
    await start();
    handlers.SIGINT();
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection lost' }));
  });

  it('disconnects and rethrows when preparing the schema fails', async () => {
    const { database } = setup();
    vi.mocked(initialize).mockRejectedValueOnce(new Error('schema failed'));
    await expect(start()).rejects.toThrow('schema failed');
    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(createApp).not.toHaveBeenCalled();
  });

  it('disconnects and rethrows when the port cannot be bound', async () => {
    const { database } = setup({ listenError: new Error('EADDRINUSE') });
    await expect(start()).rejects.toThrow('EADDRINUSE');
    expect(database.$disconnect).toHaveBeenCalledOnce();
  });
});
