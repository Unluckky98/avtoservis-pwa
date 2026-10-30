import { useSearchParams } from 'react-router-dom';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { useStudio } from '../../app/StudioContext';
import { EmptyState } from '../../components/States';
import { duration, rub } from '../../lib/format';

export function ServicesPage() {
  const s = useStudio();
  const [, setParams] = useSearchParams();
  return (
    <VStack gap={4} padding={4} paddingBlockStart={8}>
      <Heading level={1}>Услуги</Heading>
      {s.services.length === 0 ? (
        <EmptyState title="Услуг пока нет" text="Студия ещё не добавила услуги. Позвоните нам." />
      ) : (
        <VStack gap={3} as="ul" className="m-0 p-0 list-none">
          {s.services.map((x) => (
            <li key={x.id} className="card-glass p-4">
              <VStack gap={2}>
                <HStack justify="between" gap={3} vAlign="start">
                  <Heading level={3}>{x.name}</Heading>
                  <Text weight="semibold" hasTabularNumbers>{rub(x.price_cents)}</Text>
                </HStack>
                {x.description && <Text color="secondary">{x.description}</Text>}
                <Text type="supporting">{duration(x.duration_minutes)}</Text>
                <Button label="Записаться" variant="primary" onClick={() => setParams({ book: x.id })} width="100%" />
              </VStack>
            </li>
          ))}
        </VStack>
      )}
    </VStack>
  );
}
