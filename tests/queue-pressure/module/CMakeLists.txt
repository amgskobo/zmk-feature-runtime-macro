# SPDX-License-Identifier: MIT
if(CONFIG_RUNTIME_MACRO_PRESSURE_TEST)
  target_sources(app PRIVATE src/pressure_test.c)
endif()
