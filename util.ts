import { Vector } from 'omegga';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 6;

const {
  d2o,
  BRICK_CONSTANTS: { translationTable },
} = OMEGGA_UTIL.brick;

export const randomId = (length = ID_LENGTH) => {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return id;
};

const rot = d2o(4, 1);
export const rotateVec = (point: Vector, times: number) => {
  let p = point;
  for (let i = 0; i < times; i++) {
    p = translationTable[rot](p);
  }
  return p;
};
