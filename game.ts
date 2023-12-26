import { Brick, UnrealColor, Vector, WriteSaveObject } from 'omegga';
const { rotate_z } = OMEGGA_UTIL.brick;

export const BOARD_DIM = 10;
export const CELL_SIZE = 2;
export const BG_COLOR: [number, number, number, number] = [100, 100, 100, 255];
export const SHIPS: {
  name: string;
  length: number;
  color: [number, number, number];
}[] = [
  { name: 'Carrier', length: 5, color: [196, 40, 28] },
  { name: 'Battleship', length: 4, color: [13, 105, 172] },
  { name: 'Cruiser', length: 3, color: [245, 205, 48] },
  { name: 'Submarine', length: 3, color: [75, 151, 75] },
  { name: 'Patrol Boat', length: 2, color: [107, 50, 124] },
];

export const LEFT_BOARD_OFFSET: Vector = [-(BOARD_DIM + 3) * CELL_SIZE, 0, 0];
export const RIGHT_BOARD_OFFSET: Vector = [(BOARD_DIM + 3) * CELL_SIZE, 0, 0];

export type Game = {
  active: boolean;
  players: [string, string];
  zone: string;
  playSpace: [Vector, Vector];
  interactId: string;
  uuids: { root: string } & Record<string, string>;
  state: GameState;
};

export type GameState =
  | {
      type: 'setup';
      boards: [SetupBoard, SetupBoard];
      timeout: NodeJS.Timeout;
      selected: [[number, number] | null, [number, number] | null];
      confirmed: [boolean, boolean];
    }
  | {
      type: 'play';
      playerTurn: number;
      timeout?: NodeJS.Timeout;
      selected?: [number, number];
      boards: [GameBoard, GameBoard];
    };

export type SetupBoard = { x: number; y: number; ship: number; rotated?: boolean }[];
export type GameBoard = {
  ships: {
    ship: number;
    x: number;
    y: number;
    rotated?: boolean;
    sunk?: boolean;
    hits: number[];
  }[];
  misses: [number, number][];
};

function shipsIntersect(a: SetupBoard[number], alen: number, b: SetupBoard[number], blen: number) {
  // Calculate end points for each line
  const endX1 = a.rotated ? a.x : a.x + alen - 1;
  const endY1 = a.rotated ? a.y + alen - 1 : a.y;
  const endX2 = b.rotated ? b.x : b.x + blen - 1;
  const endY2 = b.rotated ? b.y + blen - 1 : b.y;

  // Check if one line is horizontal and the other is vertical
  if (a.rotated !== b.rotated) {
    return a.rotated
      ? a.x >= b.x && a.x <= endX2 && b.y >= a.y && b.y <= endY1
      : b.x >= a.x && b.x <= endX1 && a.y >= b.y && a.y <= endY2;
  }

  // For lines with same orientation, check if they are on the same level and overlap
  return a.rotated
    ? a.x === b.x && Math.max(a.y, b.y) <= Math.min(endY1, endY2)
    : a.y === b.y && Math.max(a.x, b.x) <= Math.min(endX1, endX2);
}

export const intersectsWithSetupBoard = (board: SetupBoard, s: SetupBoard[number]): boolean => {
  if (board.length === 0) return false;

  const slen = SHIPS[s.ship].length;
  for (const c of board) {
    const clen = SHIPS[c.ship].length;
    if (shipsIntersect(s, slen, c, clen)) return true;
  }

  return false;
};

export const setupGameBoard = (board: SetupBoard): GameBoard => ({
  ships: board.map((data) => ({ ...data, hits: [] })),
  misses: [],
});

export const checkHit = (
  pos: [number, number],
  board: GameBoard
):
  | { result: 'miss' }
  | { result: 'hit'; ship: GameBoard['ships'][number]; at: number }
  | { result: 'already_hit' }
  | { result: 'already_miss' } => {
  for (const ship of board.ships) {
    const len = SHIPS[ship.ship].length;

    let hit = -1;
    if (ship.rotated && pos[0] === ship.x && ship.y <= pos[1] && ship.y + len - 1 >= pos[1]) {
      hit = pos[1] - ship.y;
    } else if (
      !ship.rotated &&
      pos[1] === ship.y &&
      ship.x <= pos[0] &&
      ship.x + len - 1 >= pos[0]
    ) {
      hit = pos[0] - ship.x;
    }

    if (hit !== -1) {
      return ship.hits.includes(hit) ? { result: 'already_hit' } : { result: 'hit', ship, at: hit };
    }
  }

  for (const miss of board.misses) {
    if (miss[0] === pos[0] && miss[1] === pos[1]) {
      return { result: 'already_miss' };
    }
  }

  return { result: 'miss' };
};

export const genBoard = (uuid: string, interactId?: string, board?: boolean): WriteSaveObject => {
  const save: WriteSaveObject = {
    brick_assets: ['PB_DefaultMicroBrick'],
    colors: [BG_COLOR],
    brick_owners: [{ id: uuid, name: 'Battleship' }],
    bricks: [],
  };

  // add back board
  if (board) {
    save.bricks.push({
      asset_name_index: 0,
      size: [CELL_SIZE * BOARD_DIM, CELL_SIZE, CELL_SIZE * BOARD_DIM],
      position: [0, -CELL_SIZE, 0],
      color: 0,
      owner_index: 1,
    });
  }

  // add cells
  for (let y = 0; y < BOARD_DIM; y++) {
    for (let x = 0; x < BOARD_DIM; x++) {
      const brick: Brick = {
        asset_name_index: 0,
        size: [CELL_SIZE, CELL_SIZE, CELL_SIZE],
        position: [
          (x - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
          CELL_SIZE,
          -(y - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
        ],
        color: 0,
        owner_index: 1,
        components: {},
      };

      if (interactId) {
        brick.components.BCD_Interact = {
          bPlayInteractSound: true,
          Message: '',
          ConsoleTag: `_bs:${interactId}:${x}:${y}`,
        };
      }

      save.bricks.push(brick);
    }
  }

  return save;
};

export const genBoardWithShips = (
  uuid: string,
  ships: { ship: number; x: number; y: number; rotated?: boolean }[]
): WriteSaveObject => {
  const save: WriteSaveObject = {
    brick_assets: ['PB_DefaultMicroBrick'],
    colors: [BG_COLOR, ...SHIPS.map((s) => [...s.color, 255] as UnrealColor)],
    brick_owners: [{ id: uuid, name: 'Battleship' }],
    bricks: [],
  };

  // add cells
  for (let y = 0; y < BOARD_DIM; y++) {
    for (let x = 0; x < BOARD_DIM; x++) {
      let color = 0;
      for (const ship of ships) {
        const len = SHIPS[ship.ship].length;
        if (
          ship.rotated
            ? ship.x === x && ship.y <= y && ship.y + len - 1 >= y
            : ship.y === y && ship.x <= x && ship.x + len - 1 >= x
        ) {
          color = ship.ship + 1;
          break;
        }
      }

      const brick: Brick = {
        asset_name_index: 0,
        size: [CELL_SIZE, CELL_SIZE, CELL_SIZE],
        position: [
          (x - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
          CELL_SIZE,
          -(y - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
        ],
        color,
        owner_index: 1,
        components: {},
      };

      save.bricks.push(brick);
    }
  }

  return save;
};

export const genShip = (
  shipIdx: number,
  uuid: string,
  at?: { interactId?: string; pos: [number, number]; rotated?: boolean }
): WriteSaveObject => {
  const ship = SHIPS[shipIdx];
  const save: WriteSaveObject = {
    brick_assets: ['PB_DefaultMicroBrick'],
    brick_owners: [{ id: uuid, name: 'Battleship' }],
    bricks: [],
    colors: [[...ship.color, 255] as [number, number, number, number]],
  };

  for (let i = 0; i < ship.length; i++) {
    const brick: Brick = {
      asset_name_index: 0,
      size: [CELL_SIZE, CELL_SIZE, CELL_SIZE],
      position: at
        ? [
            // lord have mercy
            (at.pos[0] + (at.rotated ? 0 : i) - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
            CELL_SIZE * 3,
            -(at.pos[1] + (at.rotated ? i : 0) - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
          ]
        : [
            -(BOARD_DIM / 2 + 2.5 + i) * CELL_SIZE * 2,
            CELL_SIZE,
            -((shipIdx - 2) * 2) * CELL_SIZE * 2,
          ],
      color: 0,
      owner_index: 1,
      components: {
        BCD_Interact: {
          bPlayInteractSound: false,
          ConsoleTag: at?.interactId ? `_bs:${at.interactId}:s${shipIdx}` : '',
          Message: at ? '' : `<b>${ship.name}</b><br>${ship.length} units`,
        },
      },
    };

    save.bricks.push(brick);
  }

  return save;
};

export const genSelection = (x: number, y: number, uuid: string): WriteSaveObject => {
  return {
    brick_assets: ['PB_DefaultMicroBrick'],
    materials: ['BMC_Hologram'],
    brick_owners: [{ id: uuid, name: 'Battleship' }],
    bricks: [
      {
        asset_name_index: 0,
        size: [CELL_SIZE, 1, CELL_SIZE],
        position: [
          (x - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
          CELL_SIZE * 2 + 1,
          -(y - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
        ],
        color: 0,
        material_index: 0,
        owner_index: 1,
        collision: { interaction: false },
      },
    ],
    colors: [[255, 0, 0, 255]],
  };
};

export const genMarker = (
  x: number,
  y: number,
  uuid: string,
  mine: boolean,
  miss: boolean
): WriteSaveObject => {
  return {
    brick_assets: ['PB_DefaultPole'],
    brick_owners: [{ id: uuid, name: 'Battleship' }],
    bricks: [
      {
        asset_name_index: 0,
        size: [CELL_SIZE, CELL_SIZE, 1],
        position: [
          (x - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
          // CELL_SIZE * (3 + (mine && !miss ? 2 : 0)),
          CELL_SIZE * 2 + 1,
          -(y - BOARD_DIM / 2 + 0.5) * CELL_SIZE * 2,
        ],
        color: 0,
        direction: 2,
        rotation: 0,
        owner_index: 1,
        components: {
          BCD_Interact: {
            bPlayInteractSound: false,
            Message: mine
              ? miss
                ? 'Your opponent missed here.'
                : 'Your opponent hit here.'
              : miss
              ? 'You missed your opponent here.'
              : 'You hit your opponent here.',
            ConsoleTag: '',
          },
        },
      },
    ],
    colors: [miss ? [255, 255, 255, 255] : [255, 0, 0, 255]],
  };
};
