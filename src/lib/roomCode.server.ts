import { randomInt } from "crypto";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@/lib/roomCode";

/**
 * Server-side room code minting (cryptographic RNG). Never shipped to the
 * client bundle; the database UNIQUE constraint is the final arbiter.
 */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
