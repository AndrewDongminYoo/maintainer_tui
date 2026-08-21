import { expect, test } from "bun:test";

import {
  moveListNavigation,
  normalizeListNavigation,
  scrollbarThumb,
  setListCursor,
} from "./list-navigation.ts";

test("moving past the last visible repository advances the viewport with the cursor", () => {
  expect(moveListNavigation({ cursor: 4, scrollTop: 0 }, 1, 20, 5)).toEqual({
    cursor: 5,
    scrollTop: 1,
  });
});

test("repeated movement keeps every cursor step before React renders", () => {
  let navigation = { cursor: 0, scrollTop: 0 };

  for (let count = 0; count < 8; count += 1) {
    navigation = moveListNavigation(navigation, 1, 20, 5);
  }

  expect(navigation).toEqual({ cursor: 8, scrollTop: 4 });

  for (let count = 0; count < 8; count += 1) {
    navigation = moveListNavigation(navigation, -1, 20, 5);
  }

  expect(navigation).toEqual({ cursor: 0, scrollTop: 0 });
});

test("normalization clamps an end cursor after filtering shortens the list", () => {
  expect(normalizeListNavigation({ cursor: 19, scrollTop: 15 }, 2, 5)).toEqual({
    cursor: 1,
    scrollTop: 0,
  });
});

test("moving after a filter shrink starts from the normalized cursor", () => {
  expect(moveListNavigation({ cursor: 19, scrollTop: 15 }, -1, 2, 5)).toEqual({
    cursor: 0,
    scrollTop: 0,
  });
});

test("normalization advances the viewport when the terminal becomes shorter", () => {
  expect(normalizeListNavigation({ cursor: 19, scrollTop: 15 }, 20, 3)).toEqual({
    cursor: 19,
    scrollTop: 17,
  });
});

test("setting the cursor to the final repository keeps it visible", () => {
  expect(setListCursor({ cursor: 0, scrollTop: 0 }, 19, 20, 5)).toEqual({
    cursor: 19,
    scrollTop: 15,
  });
});

test("an overflowing list maps first middle and final offsets to a clamped thumb", () => {
  expect(scrollbarThumb(20, 5, 0)).toEqual({ top: 0, height: 2 });
  expect(scrollbarThumb(20, 5, 8)).toEqual({ top: 2, height: 2 });
  expect(scrollbarThumb(20, 5, 15)).toEqual({ top: 3, height: 2 });
});

test("a fitting list fills the complete scrollbar track", () => {
  expect(scrollbarThumb(3, 5, 0)).toEqual({ top: 0, height: 5 });
});

test("an empty list has a stable empty navigation state", () => {
  expect(normalizeListNavigation({ cursor: 3, scrollTop: 2 }, 0, 5)).toEqual({
    cursor: 0,
    scrollTop: 0,
  });
});
