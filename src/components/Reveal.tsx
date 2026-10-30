import type { ReactNode } from 'react';
import { useReveal } from '../lib/motion';

export function Reveal({ children, as: Tag = 'section', className = '' }: { children: ReactNode; as?: 'section' | 'div'; className?: string }) {
  const ref = useReveal<HTMLElement>();
  return (
    <Tag ref={ref as never} className={`reveal ${className}`}>
      {children}
    </Tag>
  );
}
