import { createContext, useContext } from 'react';
import type { Studio } from '../lib/api';

export const StudioContext = createContext<Studio | null>(null);
export function useStudio(): Studio {
  const s = useContext(StudioContext);
  if (!s) throw new Error('useStudio outside StudioProvider');
  return s;
}
