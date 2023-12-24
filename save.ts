import { Brick, BrsV10, Vector, WriteSaveObject } from 'omegga';
import fs from 'fs';
import { BOARD_DIM, CELL_SIZE } from './game';

const { rotate_z } = OMEGGA_UTIL.brick;

export const moveSave = (save: WriteSaveObject, to: Vector, rotation = 0) => {
  const rotate = rotate_z(rotation);
  for (let i = 0; i < save.bricks.length; i++) {
    save.bricks[i] = rotate(save.bricks[i]);
    save.bricks[i].position = save.bricks[i].position.map((c, j) => c + to[j]) as Vector;
  }
};

export const deepEquals = (a: any, b: any): boolean => {
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;

    return a.length === b.length && a.every((e, i) => deepEquals(e, b[i]));
  } else if (typeof a === 'object') {
    if (typeof b !== 'object') return false;

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!deepEquals(a[key], b[key])) return false;
    }

    return true;
  } else {
    return a === b;
  }
};

export const deepClone = <T>(a: T): T => {
  if (Array.isArray(a)) {
    return a.map(deepClone) as T;
  } else if (typeof a === 'object') {
    if (a === null) return a;
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, deepClone(v)])) as T;
  } else {
    return a;
  }
};

type SaveArrayKeys = {
  [K in keyof WriteSaveObject]: WriteSaveObject[K] extends Array<any> ? K : never;
}[keyof WriteSaveObject];

const mergeAssets = <Key extends SaveArrayKeys, BrickKey extends keyof Brick>(
  key: Key,
  brickKey: BrickKey,
  a: WriteSaveObject,
  b: WriteSaveObject
): [WriteSaveObject[Key], (brick: Brick) => void] => {
  // skip comparison if the two asset groups are equivalent
  if (deepEquals(a[key], b[key])) return [a[key], (brick) => brick];

  const assets = a[key] as unknown[];
  const bMap: Record<number, number> = {};

  for (const bIdx in b[key]) {
    let found = false;
    for (let aIdx = 0; aIdx < assets.length; aIdx++) {
      if (deepEquals(assets[aIdx], b[key][bIdx])) {
        bMap[bIdx] = aIdx;
        found = true;
        break;
      }
    }

    if (!found) {
      bMap[bIdx] = assets.length;
      assets.push(b[key][bIdx]);
    }
  }

  return [
    assets as WriteSaveObject[Key],
    (brick) => {
      if (typeof brick[brickKey] !== 'number') return;
      if (brickKey === 'owner_index' && brick[brickKey] !== 0) {
        brick[brickKey] = ((bMap[(brick[brickKey] as number) - 1] as number) + 1) as any;
      } else {
        brick[brickKey] = bMap[brick[brickKey] as number] as any;
      }
    },
  ];
};

const SAVE_DEFAULTS = {
  materials: ['BMC_Plastic'],
  brick_assets: ['PB_DefaultBrick'],
  colors: [[0, 0, 0, 0]],
  physical_materials: ['BPMC_Default'],
};

/**
 * Attempts to merge `b` into `a`. After the operation `a` is no longer usable on its own.
 */
export const mergeSave = (a: WriteSaveObject, b: WriteSaveObject): WriteSaveObject => {
  for (const [key, value] of Object.entries(SAVE_DEFAULTS)) {
    if (!a[key]?.length) a[key] = deepClone(value);
    if (!b[key]?.length) b[key] = deepClone(value);
  }

  const [brick_assets, fixBrickAsset] = mergeAssets('brick_assets', 'asset_name_index', a, b);
  const [colors, fixColor] = mergeAssets('colors', 'color', a, b);
  const [materials, fixMaterial] = mergeAssets('materials', 'material_index', a, b);
  const [brick_owners, fixOwner] = mergeAssets('brick_owners', 'owner_index', a, b);
  const [physical_materials, fixPhyMaterial] = mergeAssets(
    'physical_materials',
    'physical_index',
    a,
    b
  );

  const bricks = a.bricks;
  for (const brick of b.bricks) {
    fixBrickAsset(brick);
    fixColor(brick);
    fixMaterial(brick);
    fixOwner(brick);
    fixPhyMaterial(brick);
    bricks.push(brick);
  }

  return { ...a, brick_assets, colors, materials, brick_owners, physical_materials, bricks };
};

export const loadAsset = (path: string): BrsV10 => {
  const save = OMEGGA_UTIL.brs.read(fs.readFileSync(path)) as BrsV10;
  const bounds = OMEGGA_UTIL.brick.getBounds(save);
  for (const brick of save.bricks) {
    brick.position = brick.position.map((c, i) => c - bounds.center[i]) as Vector;
    brick.owner_index = 0;
  }
  return save;
};

export const ASSET_BOARD = loadAsset('plugins/battleship/assets/board.brs');
export const ASSET_CONFIRM = loadAsset('plugins/battleship/assets/confirm.brs');
export const ASSET_PLACE_SHIPS = loadAsset('plugins/battleship/assets/place_ships.brs');
export const ASSET_THEIR_SHOTS = loadAsset('plugins/battleship/assets/their_shots.brs');
export const ASSET_YOUR_SHOTS = loadAsset('plugins/battleship/assets/your_shots.brs');

// move confirm button
{
  const bounds = OMEGGA_UTIL.brick.getBounds(ASSET_CONFIRM);
  moveSave(ASSET_CONFIRM, [0, 0, -(BOARD_DIM / 2 + 1) * CELL_SIZE * 2 - bounds.maxBound[2]]);
}

// move shot text
{
  const bounds = OMEGGA_UTIL.brick.getBounds(ASSET_YOUR_SHOTS);
  moveSave(ASSET_YOUR_SHOTS, [0, 0, (BOARD_DIM / 2 + 1) * CELL_SIZE * 2 + 2 + bounds.maxBound[2]]);
  moveSave(ASSET_THEIR_SHOTS, [0, 0, (BOARD_DIM / 2 + 1) * CELL_SIZE * 2 + 2 + bounds.maxBound[2]]);
}

// move setup text
{
  const bounds = OMEGGA_UTIL.brick.getBounds(ASSET_PLACE_SHIPS);
  moveSave(ASSET_PLACE_SHIPS, [0, 0, (BOARD_DIM / 2 + 1) * CELL_SIZE * 2 + 2 + bounds.maxBound[2]]);
}
