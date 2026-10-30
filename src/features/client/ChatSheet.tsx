import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Button } from '@astryxdesign/core/Button';
import { X } from '@phosphor-icons/react';
import { AssistantChat } from '../../components/AssistantChat';
import { supabase } from '../../lib/supabase';
import { useStudio } from '../../app/StudioContext';

export function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const studio = useStudio();
  return (
    <BottomSheet isOpen={open} onOpenChange={(o) => !o && onClose()} label="Помощник" height="tall" purpose="info">
      <VStack gap={3}>
        <HStack justify="between" vAlign="center">
          <Heading level={2}>Помощник студии</Heading>
          <Button label="Закрыть" icon={<X size={22} aria-hidden="true" />} isIconOnly variant="ghost" onClick={onClose} />
        </HStack>
        <AssistantChat client={supabase} slug={studio.slug} mode="client" hints={['Какие у вас услуги и цены?', 'Когда можно записаться на мойку?', 'Где вы находитесь?']} />
      </VStack>
    </BottomSheet>
  );
}
