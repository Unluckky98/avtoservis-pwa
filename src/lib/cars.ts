/** Brand → models, the common ones on the Russian market. Anything missing is entered by hand ("Другая…"). */
export const CAR_OTHER = '__other__';

export const CARS: Record<string, string[]> = {
  Audi: ['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q3', 'Q5', 'Q7', 'Q8', 'e-tron', 'RS6', 'TT'],
  BMW: ['1 серии', '3 серии', '5 серии', '7 серии', 'X1', 'X3', 'X4', 'X5', 'X6', 'X7', 'M3', 'M5', 'i4', 'iX'],
  'Mercedes-Benz': ['A-класс', 'C-класс', 'E-класс', 'S-класс', 'CLA', 'GLA', 'GLC', 'GLE', 'GLS', 'G-класс', 'V-класс', 'AMG GT'],
  Volkswagen: ['Polo', 'Golf', 'Passat', 'Jetta', 'Tiguan', 'Touareg', 'Teramont', 'Caddy', 'Transporter', 'ID.4'],
  Toyota: ['Corolla', 'Camry', 'RAV4', 'Land Cruiser 200', 'Land Cruiser 300', 'Land Cruiser Prado', 'Highlander', 'Fortuner', 'Hilux', 'Alphard'],
  Lexus: ['ES', 'IS', 'LS', 'NX', 'RX', 'GX', 'LX', 'UX'],
  Porsche: ['911', 'Panamera', 'Cayenne', 'Macan', 'Taycan', 'Cayman', 'Boxster'],
  'Land Rover': ['Defender', 'Discovery', 'Range Rover', 'Range Rover Sport', 'Range Rover Velar', 'Evoque'],
  Skoda: ['Rapid', 'Octavia', 'Superb', 'Kodiaq', 'Karoq', 'Kamiq'],
  Kia: ['Rio', 'Ceed', 'Cerato', 'K5', 'Optima', 'Sportage', 'Sorento', 'Seltos', 'Soul', 'Carnival', 'Stinger'],
  Hyundai: ['Solaris', 'Elantra', 'Sonata', 'Creta', 'Tucson', 'Santa Fe', 'Palisade', 'Genesis'],
  Genesis: ['G70', 'G80', 'G90', 'GV70', 'GV80'],
  Nissan: ['Almera', 'Qashqai', 'X-Trail', 'Juke', 'Murano', 'Teana', 'Patrol', 'Note'],
  Infiniti: ['Q50', 'QX50', 'QX60', 'QX80'],
  Mazda: ['Mazda 3', 'Mazda 6', 'CX-5', 'CX-7', 'CX-9', 'CX-30'],
  Honda: ['Civic', 'Accord', 'CR-V', 'HR-V', 'Pilot', 'Fit'],
  Mitsubishi: ['Lancer', 'ASX', 'Outlander', 'Pajero Sport', 'L200', 'Eclipse Cross'],
  Subaru: ['Impreza', 'Legacy', 'Forester', 'Outback', 'XV', 'WRX'],
  Ford: ['Focus', 'Mondeo', 'Fiesta', 'Kuga', 'Explorer', 'Mustang', 'Transit'],
  Chevrolet: ['Cruze', 'Lacetti', 'Niva', 'Aveo', 'Tahoe', 'Camaro', 'Captiva'],
  Cadillac: ['CT5', 'Escalade', 'XT5', 'XT6'],
  Jeep: ['Wrangler', 'Grand Cherokee', 'Compass', 'Renegade'],
  Tesla: ['Model 3', 'Model S', 'Model X', 'Model Y', 'Cybertruck'],
  Volvo: ['S60', 'S90', 'V60', 'XC40', 'XC60', 'XC90'],
  Renault: ['Logan', 'Sandero', 'Duster', 'Kaptur', 'Arkana', 'Megane'],
  Peugeot: ['208', '308', '408', '3008', '5008', 'Partner'],
  Citroen: ['C3', 'C4', 'C5 Aircross', 'Berlingo'],
  Opel: ['Astra', 'Corsa', 'Insignia', 'Mokka', 'Zafira'],
  Mini: ['Cooper', 'Countryman', 'Clubman'],
  Jaguar: ['XE', 'XF', 'F-Pace', 'F-Type', 'E-Pace'],
  Suzuki: ['Vitara', 'SX4', 'Jimny', 'Swift'],
  Lada: ['Granta', 'Vesta', 'Niva Legend', 'Niva Travel', 'Largus', 'Priora', 'XRAY'],
  Haval: ['Jolion', 'F7', 'F7x', 'Dargo', 'H9', 'M6'],
  Geely: ['Coolray', 'Atlas', 'Monjaro', 'Tugella', 'Emgrand'],
  Chery: ['Tiggo 4', 'Tiggo 7 Pro', 'Tiggo 8 Pro', 'Arrizo 8'],
  Exeed: ['TXL', 'VX', 'LX', 'RX'],
  Changan: ['CS35 Plus', 'CS55 Plus', 'CS75 Plus', 'UNI-K', 'UNI-V'],
  Bentley: ['Continental GT', 'Flying Spur', 'Bentayga'],
  'Rolls-Royce': ['Ghost', 'Wraith', 'Cullinan', 'Phantom', 'Dawn'],
  Maserati: ['Ghibli', 'Levante', 'Quattroporte', 'MC20'],
  Lamborghini: ['Huracan', 'Urus', 'Aventador', 'Revuelto'],
  Ferrari: ['488', 'F8', 'Roma', 'SF90', '812'],
  'Aston Martin': ['DB11', 'DBX', 'Vantage'],
  Bugatti: ['Chiron', 'Veyron', 'Divo'],
};

export const CAR_BRANDS = Object.keys(CARS).sort((a, b) => a.localeCompare(b));

export type CarValue = { brand: string; model: string; custom: string };
export const EMPTY_CAR: CarValue = { brand: '', model: '', custom: '' };

/** "Porsche Panamera" for the booking; falls back to whatever was typed by hand. */
export function carString(v: CarValue): string {
  if (!v.brand) return v.custom.trim();
  if (v.brand === CAR_OTHER) return v.custom.trim();
  const model = v.model === CAR_OTHER ? v.custom.trim() : v.model;
  return [v.brand, model].filter(Boolean).join(' ');
}
