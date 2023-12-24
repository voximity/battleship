import {
  ASSET_BOARD,
  ASSET_CONFIRM,
  ASSET_PLACE_SHIPS,
  ASSET_THEIR_SHOTS,
  ASSET_YOUR_SHOTS,
  deepClone,
  mergeSave,
  moveSave,
} from './save';
import {
  Game,
  GameBoard,
  LEFT_BOARD_OFFSET,
  RIGHT_BOARD_OFFSET,
  SHIPS,
  checkHit,
  genBoard,
  genBoardWithShips,
  genMarker,
  genSelection,
  genShip,
  intersectsWithSetupBoard,
  setupGameBoard,
} from './game';
import { randomId, rotateVec } from './util';
import OmeggaPlugin, { OL, PS, PC, OmeggaPlayer, Vector } from 'omegga';

const { random: uuid } = OMEGGA_UTIL.uuid;
const { bold, red, yellow, cyan, code } = OMEGGA_UTIL.chat;

type Config = {
  round_length: number;
  setup_timeout: number;
  invite_timeout: number;
  auth_setup: string[];
  broadcast: boolean;
  enforce_max_zone_dist: boolean;
  max_zone_dist: number;
};

type Storage = {
  zones: {
    name: string;
    pos: [Vector, Vector];
    rotation: [number, number];
  }[];
  uuids: string[];
};

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;

  games: Game[] = [];
  queue: [string, string][] = [];
  invites: { from: string; to: string; timeout: NodeJS.Timeout }[] = [];
  zones: Storage['zones'];
  allUuids: string[];
  freeUuids: string[];

  setupPromises: Record<string, (...args: string[]) => void> = {};

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;
  }

  takeUuid = () => {
    if (this.freeUuids.length > 0) {
      return this.freeUuids.pop();
    }

    const id = uuid();
    this.allUuids.push(id);
    this.store.set('uuids', this.allUuids);
    return id;
  };

  freeUuid = (uuid: string) => {
    this.freeUuids.push(uuid);
  };

  broadcast = (...message: string[]) => {
    this.omegga.broadcast(`${yellow('[Battleship]')} ${message.join('')}`);
  };

  hasAuth = (user: OmeggaPlayer | string) => {
    const p = typeof user === 'string' ? this.omegga.getPlayer(user) : user;

    return p.isHost() || p.getRoles().some((r) => this.config.auth_setup.includes(r));
  };

  createSetupPromise = (user: OmeggaPlayer | string): Promise<string[]> => {
    const id = typeof user === 'string' ? this.omegga.getPlayer(user).id : user.id;

    if (id in this.setupPromises) throw 'user already has active promise';

    return new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.setupPromises[id];
        reject('timed_out');
      }, 30_000);

      this.setupPromises[id] = (...data: string[]) => {
        clearTimeout(timeout);
        delete this.setupPromises[id];
        resolve(data);
      };
    });
  };

  getAvailableZone = () => this.zones.find((z) => !this.games.some((g) => g.zone === z.name));
  startGame = async (player1: string, player2: string): Promise<Game> => {
    const zone = this.getAvailableZone();
    if (!zone) throw 'no_zone_available';

    const id = randomId();

    const uuids = {
      root: this.takeUuid(),
      p0s: this.takeUuid(),
      p1s: this.takeUuid(),
      p0c: this.takeUuid(),
      p1c: this.takeUuid(),
    };
    for (let i = 0; i < 5; i++) {
      uuids['p0s' + i] = this.takeUuid();
      uuids['p1s' + i] = this.takeUuid();
    }

    // generate both boards
    const boards = [];
    for (let i = 0; i < 2; i++) {
      let save = genBoard(uuids.root, id + '_' + i);

      // add board outline
      const board = deepClone(ASSET_BOARD);
      board.brick_owners = [{ id: uuids[`p${i}c`], name: 'Battleship', bricks: 0 }];
      save = mergeSave(save, board);

      // add text
      const text = deepClone(ASSET_PLACE_SHIPS);
      text.brick_owners = [{ id: uuids[`p${i}c`], name: 'Battleship', bricks: 0 }];
      save = mergeSave(save, text);

      // add setup ships
      for (let j = 0; j < 5; j++) {
        save = mergeSave(save, genShip(j, uuids[`p${i}s${j}`]));
      }

      // add confirm button
      const confirm = deepClone(ASSET_CONFIRM);
      confirm.brick_owners = [{ id: uuids[`p${i}c`], name: 'Battleship', bricks: 0 }];
      for (const b of confirm.bricks) {
        b.owner_index = 1;
        (b.components ??= {}).BCD_Interact = {
          bPlayInteractSound: true,
          ConsoleTag: `_bs:${id + '_' + i}:c`,
          Message: '',
        };
      }

      save = mergeSave(save, confirm);

      // move save
      moveSave(save, zone.pos[i], zone.rotation[i]);
      boards.push(save);
    }

    // merge saves
    const save = mergeSave(boards[0], boards[1]);

    // get play spaces
    const playSpace = [];
    const players = [player1, player2];
    for (let i = 0; i < 2; i++) {
      playSpace.push(rotateVec([0, 60, 0], zone.rotation[i]).map((c, j) => c + zone.pos[i][j]));
    }

    // create game object
    const game: Game = {
      active: true,
      players: [player1, player2],
      zone: zone.name,
      playSpace: playSpace as [Vector, Vector],
      interactId: id,
      uuids,
      state: {
        type: 'setup',
        boards: [[], []],
        selected: [null, null],
        confirmed: [false, false],
        timeout: setTimeout(() => {
          for (const id of players) {
            this.omegga.whisper(
              this.omegga.getPlayer(id),
              red('The game ended because the boards were not set up in time.')
            );
          }

          this.forfeitGame(game);
        }, this.config.setup_timeout * 1_000),
      },
    };
    this.games.push(game);

    // load save ingame
    this.omegga.loadSaveData(save, { quiet: true });

    // teleport players
    for (const i in players) {
      this.omegga.writeln(
        `Chat.Command /TP "${this.omegga.getPlayer(players[i]).name}" ${playSpace[i].join(' ')} 0`
      );
    }

    // announce if broadcasting
    if (this.config.broadcast) {
      this.broadcast(
        `A game between ${cyan(this.omegga.getPlayer(player1).name)} and ${cyan(
          this.omegga.getPlayer(player2).name
        )} is now being set up.`
      );
    }

    return game;
  };

  finishGameSetup = async (game: Game) => {
    if (game.state.type !== 'setup') return;

    // switch to play state
    clearTimeout(game.state.timeout);
    game.state = {
      type: 'play',
      playerTurn: 0,
      boards: game.state.boards.map(setupGameBoard) as [GameBoard, GameBoard],
    };

    // clear game bricks
    for (const uuid of Object.values(game.uuids)) {
      this.omegga.clearBricks(uuid, true);
    }

    // load boards in for both players
    const zone = this.zones.find((z) => z.name === game.zone);

    const boards = [];
    for (let i = 0; i < 2; i++) {
      // generate my board
      let myBoard = genBoardWithShips(game.uuids.root, game.state.boards[i].ships);

      const myBorder = deepClone(ASSET_BOARD);
      myBorder.brick_owners = [{ id: game.uuids.root, name: 'Battleship', bricks: 0 }];
      myBoard = mergeSave(myBoard, myBorder);

      const myText = deepClone(ASSET_THEIR_SHOTS);
      myText.brick_owners = [{ id: game.uuids.root, name: 'Battleship', bricks: 0 }];
      myBoard = mergeSave(myBoard, myText);

      // generate opponent board
      let opBoard = genBoard(game.uuids.root, game.interactId + '_' + i);

      const opBorder = deepClone(ASSET_BOARD);
      opBorder.brick_owners = [{ id: game.uuids.root, name: 'Battleship', bricks: 0 }];
      opBoard = mergeSave(opBoard, opBorder);

      const opText = deepClone(ASSET_YOUR_SHOTS);
      opText.brick_owners = [{ id: game.uuids.root, name: 'Battleship', bricks: 0 }];
      opBoard = mergeSave(opBoard, opText);

      // move boards and merge
      moveSave(myBoard, LEFT_BOARD_OFFSET);
      moveSave(opBoard, RIGHT_BOARD_OFFSET);
      const save = mergeSave(myBoard, opBoard);
      moveSave(save, zone.pos[i], zone.rotation[i]);
      boards.push(save);
    }

    const save = mergeSave(boards[0], boards[1]);
    await this.omegga.loadSaveData(save, { quiet: true });

    // announce if broadcasting
    if (this.config.broadcast) {
      this.broadcast(
        `A game between ${cyan(this.omegga.getPlayer(game.players[0]).name)} and ${cyan(
          this.omegga.getPlayer(game.players[1]).name
        )} is starting!`
      );
    }

    // announce turn
    await this.setGameTurn(game, 0);
  };

  setGameTurn = async (game: Game, to: number) => {
    if (!game.active) return;
    if (game.state.type !== 'play') return;

    game.state.playerTurn = to;
    game.state.selected = undefined;

    const zone = this.zones.find((z) => z.name === game.zone);

    const confirm = deepClone(ASSET_CONFIRM);
    confirm.brick_owners = [{ id: game.uuids[`p${to}c`], name: 'Battleship', bricks: 0 }];
    delete confirm.components;
    for (const b of confirm.bricks) {
      b.owner_index = 1;
      (b.components ??= {}).BCD_Interact = {
        bPlayInteractSound: true,
        ConsoleTag: `_bs:${game.interactId + '_' + to}:c`,
        Message: '',
      };
    }

    moveSave(confirm, RIGHT_BOARD_OFFSET);
    moveSave(confirm, zone.pos[to], zone.rotation[to]);
    await this.omegga.loadSaveData(confirm, { quiet: true });

    this.omegga.whisper(
      this.omegga.getPlayer(game.players[to]),
      yellow('It is your turn!') + ' Use the board on the right to shoot at your opponent.'
    );

    const start = Date.now();
    game.state.timeout = setInterval(() => {
      if (Date.now() - start > this.config.round_length * 1_000) {
        clearInterval(game.state.timeout);
        this.gameAct(game, true);
        return;
      }

      if (Date.now() - start > this.config.round_length * 1_000 - 3_000) {
        const s = Math.ceil((this.config.round_length * 1_000 - (Date.now() - start)) / 1_000);
        this.omegga.whisper(
          this.omegga.getPlayer(game.players[to]),
          yellow(`${s} second${s !== 1 ? 's' : ''} remaining!`)
        );
      }
    }, 1_000);
  };

  gameAct = async (game: Game, force?: boolean): Promise<boolean> => {
    if (!game.active) return false;
    if (game.state.type !== 'play') return false;

    const zone = this.zones.find((z) => z.name === game.zone);
    const players = game.players.map((p) => this.omegga.getPlayer(p));
    const player = players[game.state.playerTurn];

    if (!game.state.selected) {
      // round timeout
      if (force) {
        this.omegga.clearBricks(game.uuids['p0s'], true);
        this.omegga.clearBricks(game.uuids['p1s'], true);
        this.omegga.clearBricks(game.uuids['p0c'], true);
        this.omegga.clearBricks(game.uuids['p1c'], true);

        if (game.state.timeout !== undefined) {
          clearTimeout(game.state.timeout);
          game.state.timeout = undefined;
        }

        this.omegga.whisper(
          player,
          red('You did not act in time, so your round has been forfeited.')
        );
        this.omegga.whisper(
          players[1 - game.state.playerTurn],
          yellow('Your opponent did not act in time, so their round has been forfeited.')
        );
      } else {
        this.omegga.middlePrint(player.id, red('You have not selected a spot to hit yet!'));
      }

      if (!force) return false;
    } else {
      // check for hits
      const res = checkHit(game.state.selected, game.state.boards[1 - game.state.playerTurn]);
      if (res.result === 'already_hit') {
        game.state.selected = undefined;
        this.omegga.middlePrint(player.id, red('You already hit that location!'));
        if (!force) return false;
      } else if (res.result === 'already_miss') {
        game.state.selected = undefined;
        this.omegga.middlePrint(player.id, red('You already missed at that location!'));
        if (!force) return false;
      }

      this.omegga.clearBricks(game.uuids['p0s'], true);
      this.omegga.clearBricks(game.uuids['p1s'], true);
      this.omegga.clearBricks(game.uuids['p0c'], true);
      this.omegga.clearBricks(game.uuids['p1c'], true);

      if (game.state.timeout !== undefined) {
        clearTimeout(game.state.timeout);
        game.state.timeout = undefined;
      }

      if (res.result === 'miss') {
        game.state.boards[1 - game.state.playerTurn].misses.push(game.state.selected);

        // show miss brick on both boards
        const markerA = genMarker(...game.state.selected, game.uuids.root, false, true);
        moveSave(markerA, RIGHT_BOARD_OFFSET);
        moveSave(markerA, zone.pos[game.state.playerTurn], zone.rotation[game.state.playerTurn]);

        const markerB = genMarker(...game.state.selected, game.uuids.root, true, true);
        moveSave(markerB, LEFT_BOARD_OFFSET);
        moveSave(
          markerB,
          zone.pos[1 - game.state.playerTurn],
          zone.rotation[1 - game.state.playerTurn]
        );

        await this.omegga.loadSaveData(mergeSave(markerA, markerB), { quiet: true });

        // announce miss
        this.omegga.whisper(player, red('You missed!'));
        this.omegga.whisper(players[1 - game.state.playerTurn], yellow('Your opponent missed!'));
      } else if (res.result === 'hit') {
        res.ship.hits.push(res.at);

        // show hit brick on both boards
        const markerA = genMarker(...game.state.selected, game.uuids.root, false, false);
        moveSave(markerA, RIGHT_BOARD_OFFSET);
        moveSave(markerA, zone.pos[game.state.playerTurn], zone.rotation[game.state.playerTurn]);

        const markerB = genMarker(...game.state.selected, game.uuids.root, true, false);
        moveSave(markerB, LEFT_BOARD_OFFSET);
        moveSave(
          markerB,
          zone.pos[1 - game.state.playerTurn],
          zone.rotation[1 - game.state.playerTurn]
        );

        await this.omegga.loadSaveData(mergeSave(markerA, markerB), { quiet: true });

        // check to see if ship is sunk
        if (res.ship.hits.length === SHIPS[res.ship.ship].length) {
          res.ship.sunk = true;
        }

        // announce hit
        if (res.ship.sunk) {
          if (this.config.broadcast) {
            this.broadcast(
              cyan(player.name),
              ' sunk ',
              cyan(players[1 - game.state.playerTurn].name),
              "'s ",
              bold(SHIPS[res.ship.ship].name),
              '!'
            );
          } else {
            this.omegga.whisper(
              player,
              yellow(`You sunk your opponent's ${bold(SHIPS[res.ship.ship].name)}!`)
            );
            this.omegga.whisper(
              players[1 - game.state.playerTurn],
              red(`Your opponent sunk your ${bold(SHIPS[res.ship.ship].name)}!`)
            );
          }
        } else {
          this.omegga.whisper(player, yellow("You hit one of your opponent's ships!"));
          this.omegga.whisper(
            players[1 - game.state.playerTurn],
            red(`Your opponent hit your ${bold(SHIPS[res.ship.ship].name)}!`)
          );
        }
      }
    }

    // if the other player has all of their ships hit, the game is over
    if (game.state.boards[1 - game.state.playerTurn].ships.every((ship) => ship.sunk)) {
      // announce that the game is over
      game.active = false;

      const message = [
        cyan(player.name),
        ' wins! They sunk all of ',
        cyan(players[1 - game.state.playerTurn].name),
        "'s ships.",
      ];

      if (this.config.broadcast) {
        this.broadcast(message.join(''));
      } else {
        this.omegga.whisper(player, message.join(''));
        this.omegga.whisper(players[1 - game.state.playerTurn], message.join(''));
      }

      setTimeout(async () => {
        await this.cleanupGame(game);
      }, 5000);

      return true;
    }

    // advance to next round
    await this.setGameTurn(game, 1 - game.state.playerTurn);

    return true;
  };

  forfeitGame = async (game: Game, winner?: number) => {
    game.active = false;

    const players = game.players.map((p) => this.omegga.getPlayer(p));

    const message =
      winner !== undefined
        ? [cyan(players[winner].name), ' wins by forfeit!']
        : [
            'The game between ',
            cyan(players[0].name),
            ' and ',
            cyan(players[1].name),
            ' has ended early!',
          ];

    if (this.config.broadcast) {
      this.broadcast(message.join(''));
    } else {
      this.omegga.whisper(players[0], message.join(''));
      this.omegga.whisper(players[1], message.join(''));
    }

    await this.cleanupGame(game);
  };

  cleanupGame = async (game: Game) => {
    if (game.state.type === 'setup') {
      clearTimeout(game.state.timeout);
    } else if (game.state.type === 'play') {
      clearTimeout(game.state.timeout);
    }

    // clear bricks from the game
    Object.values(game.uuids).forEach((uuid) => {
      this.freeUuid(uuid);
      this.omegga.clearBricks(uuid, true);
    });

    // remove the game from the list of games
    this.games = this.games.filter((g) => g !== game);

    // start next game in the queue
    const nextGame = this.queue.shift();
    if (nextGame) {
      await this.startGame(...nextGame);
    }
  };

  async init() {
    this.zones = (await this.store.get('zones')) ?? [];
    this.allUuids = (await this.store.get('uuids')) ?? [];
    this.freeUuids = [...this.allUuids];

    // clean up known uuids
    for (const uuid of this.allUuids) {
      this.omegga.clearBricks(uuid, true);
    }

    if (this.config.enforce_max_zone_dist) {
      setInterval(async () => {
        for (const game of this.games) {
          if (!game.active) continue;

          const positions = await Promise.all(
            game.players.map((id) => this.omegga.getPlayer(id).getPosition())
          );

          for (let i = 0; i < 2; i++) {
            const player = this.omegga.getPlayer(game.players[i]);
            const pos = positions[i];
            const dest = game.playSpace[i];
            const distSq = pos.map((c, i) => Math.pow(c - dest[i], 2)).reduce((a, c) => a + c, 0);

            const warningDist = Math.pow(this.config.max_zone_dist * 10 * 0.5, 2);
            const maxDist = Math.pow(this.config.max_zone_dist * 10, 2);

            if (distSq > maxDist) {
              // player forfeits game because they moved too far away
              this.omegga.whisper(
                player,
                red('The game ended because you moved too far away from your play space!')
              );
              this.forfeitGame(game, 1 - i);
              break;
            } else if (distSq > warningDist) {
              this.omegga.whisper(
                player,
                red('You are moving too far from your play space!') +
                  ' Return or you will forfeit your game.'
              );
              break;
            }
          }
        }
      }, 2500);
    }

    this.omegga.on('cmd:battleship', async (speaker: string, ...args: string[]) => {
      const player = this.omegga.getPlayer(speaker);

      // check for setup promises
      if (player.id in this.setupPromises) {
        this.setupPromises[player.id](...args);
        return;
      }

      const subcommand = args[0];

      const w = (...message: string[]) => this.omegga.whisper(speaker, message.join(''));

      if (subcommand === 'invite') {
        const who = args.slice(1).join(' ');

        if (!who) {
          w(red('Please specify who to invite.'));
          return;
        }

        // if the player is already in a game
        if (this.games.some((game) => game.players.some((c) => c === player.id))) {
          w(red('You are already in a game! '), 'To exit, use ', code('/battleship leave'), '.');
          return;
        }

        // if the player is already in queue
        if (this.queue.some(([a, b]) => a === player.id || b === player.id)) {
          w(red('You are already in queue! '), 'To exit, use ', code('/battleship leave'), '.');
          return;
        }

        const target = this.omegga.getPlayer(who);

        // if the target player is online
        if (!target) {
          w(red('That player is not online!'));
          return;
        }

        // if the player is themselves
        // TODO: UNCOMMENT FOR RELEASE
        // if (target.id === player.id) {
        //   w(
        //     red("You can't play by yourself!"),
        //     ' You can send an invite to the whole server with ',
        //     code('/battleship'),
        //     '.'
        //   );
        //   return;
        // }

        // if the player already has an outgoing invite to that player
        if (this.invites.some(({ from, to }) => from === player.id && to === target.id)) {
          w(red('You already have an outgoing invite to that person!'));
          return;
        }

        // if the target is already in game
        if (this.games.some((game) => game.players.some((c) => c === target.id))) {
          w(red('That person is already in a game!'));
          return;
        }

        // if the target is already in queue
        if (this.queue.some(([a, b]) => a === player.id || b === player.id)) {
          w(red('That person is already in queue!'));
          return;
        }

        // create an invite
        const timeout = setTimeout(() => {
          this.invites = this.invites.filter(
            ({ from, to }) => !(from === player.id && to === target.id)
          );
          w(red('The invite to '), cyan(target.name), red(' has timed out.'));
        }, this.config.invite_timeout * 1_000);

        this.invites.push({ from: player.id, to: target.id, timeout });

        w('Sent a Battleship invite to ', cyan(target.name), '.');
        this.omegga.whisper(
          target,
          [
            'You have received a Battleship invite from ',
            cyan(player.name),
            '! To accept, use ',
            code('/battleship accept ' + player.name),
            '.',
          ].join('')
        );
      } else if (subcommand === 'accept') {
        const who = args.slice(1).join(' ');

        if (!who) {
          w(red('Please specify what invite to accept (name of sender).'));
          return;
        }

        // if the player is already in a game
        if (this.games.some((game) => game.players.some((c) => c === player.id))) {
          w(red('You are already in a game! '), 'To exit, use ', code('/battleship leave'), '.');
          return;
        }

        // if the player is already in queue
        if (this.queue.some(([a, b]) => a === player.id || b === player.id)) {
          w(red('You are already in queue! '), 'To exit, use ', code('/battleship leave'), '.');
          return;
        }

        const invites = this.invites.filter(({ to }) => to === player.id);
        if (invites.length === 0) {
          w(red("You don't have any incoming invites."));
          return;
        }

        const target = this.omegga.getPlayer(who);
        const invite = invites.find(({ from }) => from === target.id);
        if (!invite) {
          w(red('Could not find an invite from that player. '), 'You currently have invites from:');
          for (const invite of invites) {
            w('- ', cyan(this.omegga.getPlayer(invite.from).name));
          }
          return;
        }

        clearTimeout(invite.timeout);
        this.invites.splice(this.invites.indexOf(invite), 1);

        // remove invites from existing players
        this.invites = this.invites.filter(
          (i) =>
            i.from === player.id || i.to === player.id || i.from === target.id || i.to === target.id
        );

        try {
          await this.startGame(player.id, target.id);
        } catch (e) {
          if (e === 'no_zone_available') {
            // add to queue
            this.queue.push([player.id, target.id]);

            const message = [
              yellow('You are now in queue to play Battleship.'),
              ' You will play in ',
              code(this.queue.length.toString()),
              ` game${this.queue.length !== 1 ? 's' : ''}.`,
            ];

            w(...message);
            this.omegga.whisper(target, message.join(''));
          } else {
            throw e;
          }
        }
      } else if (subcommand === 'leave') {
        // forfeit game if they are in a game
        const game = this.games.find((g) => g.players.includes(player.id));
        if (game)
          await this.forfeitGame(
            game,
            game.state.type === 'play' ? 1 - game.players.indexOf(player.id) : undefined
          );

        // remove from queue
        this.queue = this.queue.filter((g) => !g.includes(player.id));

        // remove current invites
        this.invites = this.invites.filter((i) => i.to === player.id || i.from === player.id);
      } else if (subcommand === 'zone') {
        if (!this.hasAuth(player)) return;

        if (args[1] === 'add') {
          player.loadSaveData(genBoard(uuid(), undefined, true));

          w('Position the board where the first player will be playing from, facing them.');
          w('Then, run ', code('/battleship'), '.');
          await this.createSetupPromise(player);
          const pos1 = await player.getGhostBrick();

          w('Now position the board where the second player will be playing from.');
          w('Then, run ', code('/battleship'), ' again.');
          await this.createSetupPromise(player);
          const pos2 = await player.getGhostBrick();

          w('Finally, give the play space a name so that you can refer to it later.');
          w('Use ', code('/battleship MY ZONE NAME'), '.');
          const name = (await this.createSetupPromise(player)).join(' ').trim().toLowerCase();

          if (this.zones.some((z) => z.name === name)) {
            w(red('A zone already exists with that name, please make it again.'));
            return;
          }

          const reg = /^Z_Positive_(\d+)$/;
          const rot1 = pos1.orientation.match(reg);
          const rot2 = pos2.orientation.match(reg);
          if (!rot1 || !rot2) {
            w(red('The zone can only be rotated with R, not on different axes.'));
            return;
          }

          const zone: Storage['zones'][number] = {
            name,
            pos: [pos1.location as Vector, pos2.location as Vector],
            rotation: [Number(rot1[1]) / 90, Number(rot2[1]) / 90],
          };

          this.zones.push(zone);
          await this.store.set('zones', this.zones);
          w('Battleship zone ', cyan(name), ' created.');
        } else if (args[1] === 'remove') {
          const what = args.slice(2).join(' ').trim().toLowerCase();
          if (!what || !this.zones.some((z) => z.name === what)) {
            w(red('No zone with the name ' + what + '.'));
            return;
          }

          this.zones = this.zones.filter((z) => z.name !== what);
          await this.store.set('zones', this.zones);
          w('Battleship zone ', cyan(what), ' removed.');
        } else if (args[1] === 'list') {
          w('List of zones:');
          for (const zone of this.zones) {
            w('- ', cyan(zone.name));
          }
        }
      } else {
        w(
          yellow('If you meant to invite someone to a Battleship game, '),
          'use ',
          code('/battleship invite PLAYER'),
          '.'
        );
      }
    });

    this.omegga.on('leave', async (player) => {
      // forfeit game if they are in a game
      const game = this.games.find((g) => g.players.includes(player.id));
      if (game)
        await this.forfeitGame(
          game,
          game.state.type === 'play' ? 1 - game.players.indexOf(player.id) : undefined
        );

      // remove from queue
      this.queue = this.queue.filter((g) => !g.includes(player.id));

      // remove current invites
      this.invites = this.invites.filter((i) => i.to === player.id || i.from === player.id);
    });

    this.omegga.on('interact', async ({ player, message }) => {
      const match = message.match(/^_bs:(\w+)_(\d):(.+)$/);
      if (!match) return;

      const game = this.games.find((g) => g.interactId === match[1]);
      if (!game || !game.active) return;

      const pid = Number(match[2]);
      if (player.id !== game.players[pid]) return;

      const zone = this.zones.find((z) => z.name === game.zone);

      if (game.state.type === 'setup') {
        // ignore if we already confirmed our setup
        if (game.state.confirmed[pid]) {
          this.omegga.middlePrint(player.id, red('You already confirmed your setup!'));
          return;
        }

        // setup phase, let player place ships
        if (match[3] === 'c') {
          // confirm ship placements
          if (game.state.boards[pid].length !== SHIPS.length) {
            this.omegga.middlePrint(
              player.id,
              red('You must place all of your ships to continue!')
            );
            return;
          }

          game.state.confirmed[pid] = true;
          if (game.state.confirmed.every((c) => c)) {
            // start the game
            await this.finishGameSetup(game);
          } else {
            this.omegga.middlePrint(
              player.id,
              '<b>Board confirmed!</> Waiting for your opponent to finish...'
            );
            this.omegga.whisper(
              this.omegga.getPlayer(game.players[1 - pid]),
              yellow('Your opponent has finished placing their ships! ') +
                'When you are finished, press the green button to confirm.'
            );
          }
          return;
        }

        if (match[3].startsWith('s')) {
          // remove the ship
          const i = Number(match[3].slice(1));
          game.state.boards[pid] = game.state.boards[pid].filter((s) => s.ship !== i);

          this.omegga.clearBricks(game.uuids[`p${pid}s${i}`], true);

          const save = genShip(i, game.uuids[`p${pid}s${i}`]);
          moveSave(save, zone.pos[pid], zone.rotation[pid]);
          await this.omegga.loadSaveData(save, { quiet: true });

          this.omegga.middlePrint(player.id, `Removed your <b>${SHIPS[i].name}</>.`);
          return;
        }

        const coords = match[3].split(':').map(Number) as [number, number];
        if (game.state.selected[pid]) {
          // check to see if the newly selected point is in the same line
          const [fx, fy] = game.state.selected[pid];
          const [tx, ty] = coords;

          game.state.selected[pid] = null;
          this.omegga.clearBricks(game.uuids[`p${pid}s`], true);

          const shipsUsed = game.state.boards[pid].map((s) => s.ship);
          const shipsAvailable = [...SHIPS].map((_, i) => i).filter((i) => !shipsUsed.includes(i));
          let rotated = false;
          let len = 0;
          if (fy === ty) {
            len = Math.abs(fx - tx) + 1;
          } else if (fx === tx) {
            len = Math.abs(fy - ty) + 1;
            rotated = true;
          } else {
            this.omegga.middlePrint(player.id, red('Your ship must be straight!'));
            return;
          }

          const candidateIdx = shipsAvailable.find((i) => SHIPS[i].length === len);
          if (candidateIdx === undefined) {
            this.omegga.middlePrint(
              player.id,
              red(`You don't have any ships left that are ${len} units long!`)
            );
            return;
          }

          const ship = { x: Math.min(fx, tx), y: Math.min(fy, ty), ship: candidateIdx, rotated };
          if (intersectsWithSetupBoard(game.state.boards[pid], ship)) {
            this.omegga.middlePrint(player.id, red('A ship is already in that spot!'));
            return;
          }

          game.state.boards[pid].push(ship);

          this.omegga.clearBricks(game.uuids[`p${pid}s${candidateIdx}`], true);
          const save = genShip(candidateIdx, game.uuids[`p${pid}s${candidateIdx}`], {
            interactId: game.interactId + '_' + pid,
            pos: [ship.x, ship.y],
            rotated,
          });
          moveSave(save, zone.pos[pid], zone.rotation[pid]);
          await this.omegga.loadSaveData(save, { quiet: true });

          this.omegga.middlePrint(player.id, `Placed your <b>${SHIPS[candidateIdx].name}</>.`);
        } else {
          // create the selection brick
          game.state.selected[pid] = coords as [number, number];

          const save = genSelection(...coords, game.uuids[`p${pid}s`]);
          moveSave(save, zone.pos[pid], zone.rotation[pid]);
          await this.omegga.loadSaveData(save, { quiet: true });

          this.omegga.middlePrint(player.id, 'Click another cell to place your ship.');
        }
      } else if (game.state.type === 'play') {
        if (pid !== game.state.playerTurn) {
          this.omegga.middlePrint(player.id, red('It is not your turn!'));
          return;
        }

        if (match[3] === 'c') {
          try {
            await this.gameAct(game);
          } catch (e) {
            console.error(e);
          }
          return;
        }

        const coords = match[3].split(':').map(Number) as [number, number];

        // create the selection brick
        game.state.selected = coords as [number, number];

        this.omegga.clearBricks(game.uuids[`p${pid}s`], true);
        const save = genSelection(...coords, game.uuids[`p${pid}s`]);
        moveSave(save, RIGHT_BOARD_OFFSET);
        moveSave(save, zone.pos[pid], zone.rotation[pid]);
        await this.omegga.loadSaveData(save, { quiet: true });

        this.omegga.middlePrint(
          player.id,
          'Click the green button to confirm you want to hit this target.'
        );
      }
    });

    // TODO: forfeit if any player moves too far away from their play space

    return { registeredCommands: ['battleship'] };
  }

  async stop() {}
}
