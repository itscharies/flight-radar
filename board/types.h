#pragma once
#include <stdint.h>

struct ScreenButton {
  int16_t  x, y, w, h;
  char     url[256];
  uint8_t *pressedBitmap;
  size_t   pressedBitmapLen;
};
