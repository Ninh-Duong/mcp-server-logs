import { LogProvider, ProviderStatus } from '../types.js';
import { SeqProvider } from './seq.js';
import { OpenObserveProvider } from './openobserve.js';

export const openObserveProvider = new OpenObserveProvider();

const providers = new Map<string, LogProvider>([new SeqProvider(), openObserveProvider].map((p) => [p.name, p]));

export const getProvider = (name: string): LogProvider | undefined => {
  const key = name.toLowerCase();
  return providers.get(key === 'observe' ? 'openobserve' : key);
};
export const getAllProviders = (): LogProvider[] => [...providers.values()];
export const listProviders = (): ProviderStatus[] => getAllProviders().map((p) => p.getStatus());
