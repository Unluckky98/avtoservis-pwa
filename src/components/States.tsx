import type { ReactNode } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';

export function Loading({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <VStack padding={6} hAlign="center" gap={3} role="status" aria-live="polite">
      <Spinner size="lg" label={label} />
    </VStack>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <VStack gap={3} padding={4} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={72} index={i} />
      ))}
    </VStack>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <VStack padding={4} gap={3} role="alert">
      <Banner status="error" title="Не получилось загрузить" description={message} />
      {onRetry && <Button label="Повторить" variant="secondary" onClick={onRetry} />}
    </VStack>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <VStack padding={6} gap={2} hAlign="center">
      <Heading level={3}>{title}</Heading>
      {text && (
        <Text type="supporting" justify="center">
          {text}
        </Text>
      )}
      {action}
    </VStack>
  );
}
