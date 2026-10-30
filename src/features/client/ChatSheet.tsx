import { BottomSheet } from '@astryxdesign/core/BottomSheet';
import { VStack } from '@astryxdesign/core/VStack';
import { Heading } from '@astryxdesign/core/Heading';
import { AssistantChat } from '../../components/AssistantChat';
import { supabase } from '../../lib/supabase';
import { useStudio } from '../../app/StudioContext';

export function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const studio = useStudio();
  return (
    <BottomSheet isOpen={open} onOpenChange={(o) => !o && onClose()} label="Помощник" height="tall" purpose="form">
      <VStack gap={3}>
        <Heading level={2}>Помощник</Heading>
        <AssistantChat client={supabase} slug={studio.slug} mode="client" hints={['Какие у вас услуги и цены?', 'Когда можно записаться на мойку?', 'Где вы находитесь?']} />
      </VStack>
    </BottomSheet>
  );
}
