export interface ListNavigation {
  cursor: number;
  scrollTop: number;
}

export interface ScrollbarThumb {
  top: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function countOf(itemCount: number): number {
  return Math.max(0, Math.floor(itemCount));
}

function rowsOf(viewportRows: number): number {
  return Math.max(1, Math.floor(viewportRows));
}

export function normalizeListNavigation(
  navigation: ListNavigation,
  itemCount: number,
  viewportRows: number,
): ListNavigation {
  const count = countOf(itemCount);
  const rows = rowsOf(viewportRows);
  if (count === 0) return { cursor: 0, scrollTop: 0 };

  const cursor = clamp(Math.floor(navigation.cursor), 0, count - 1);
  const maximumScrollTop = Math.max(0, count - rows);
  let scrollTop = clamp(Math.floor(navigation.scrollTop), 0, maximumScrollTop);

  if (cursor < scrollTop) scrollTop = cursor;
  else if (cursor >= scrollTop + rows) scrollTop = cursor - rows + 1;

  return { cursor, scrollTop };
}

export function setListCursor(
  navigation: ListNavigation,
  cursor: number,
  itemCount: number,
  viewportRows: number,
): ListNavigation {
  return normalizeListNavigation({ ...navigation, cursor }, itemCount, viewportRows);
}

export function moveListNavigation(
  navigation: ListNavigation,
  delta: number,
  itemCount: number,
  viewportRows: number,
): ListNavigation {
  return setListCursor(navigation, navigation.cursor + delta, itemCount, viewportRows);
}

export function scrollbarThumb(
  itemCount: number,
  viewportRows: number,
  scrollTop: number,
): ScrollbarThumb {
  const count = countOf(itemCount);
  const rows = rowsOf(viewportRows);
  if (count <= rows) return { top: 0, height: rows };

  const height = Math.max(1, Math.ceil((rows * rows) / count));
  const maximumScrollTop = count - rows;
  const maximumThumbTop = rows - height;
  const top = Math.round(
    (clamp(Math.floor(scrollTop), 0, maximumScrollTop) * maximumThumbTop) / maximumScrollTop,
  );

  return { top, height };
}
