import { VStack } from '@astryxdesign/core/VStack';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { CARS, CAR_BRANDS, CAR_OTHER, type CarValue } from '../lib/cars';

/** Brand dropdown → model dropdown; either can be "Другая…" and then typed by hand. */
export function CarPicker({ value, onChange }: { value: CarValue; onChange: (v: CarValue) => void }) {
  const brandOptions = [
    ...CAR_BRANDS.map((b) => ({ value: b, label: b })),
    { type: 'divider' as const },
    { value: CAR_OTHER, label: 'Другая марка…' },
  ];
  const models = value.brand && value.brand !== CAR_OTHER ? CARS[value.brand] ?? [] : [];
  const modelOptions = [
    ...models.map((m) => ({ value: m, label: m })),
    { type: 'divider' as const },
    { value: CAR_OTHER, label: 'Другая модель…' },
  ];
  const typed = value.brand === CAR_OTHER || value.model === CAR_OTHER;

  return (
    <VStack gap={3}>
      <Selector
        label="Марка автомобиля"
        options={brandOptions}
        value={value.brand || null}
        onChange={(brand) => onChange({ brand: brand ?? '', model: '', custom: '' })}
        placeholder="Выберите марку"
        hasSearch
        hasClear
        searchPlaceholder="Найти марку"
        emptySearchText="Не найдено, выберите «Другая марка»"
        isOptional
      />
      {value.brand && value.brand !== CAR_OTHER && (
        <Selector
          label="Модель"
          options={modelOptions}
          value={value.model || undefined}
          onChange={(model) => onChange({ ...value, model: model ?? '', custom: '' })}
          placeholder="Выберите модель"
          hasSearch
          searchPlaceholder="Найти модель"
          emptySearchText="Не найдено, выберите «Другая модель»"
        />
      )}
      {typed && (
        <TextInput
          label={value.brand === CAR_OTHER ? 'Марка и модель' : 'Название модели'}
          value={value.custom}
          onChange={(custom) => onChange({ ...value, custom })}
          placeholder={value.brand === CAR_OTHER ? 'Например, Zeekr 001' : 'Например, Cayenne Coupe'}
        />
      )}
    </VStack>
  );
}
