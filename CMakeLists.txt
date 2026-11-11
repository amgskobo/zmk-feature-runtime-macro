zephyr_include_directories(include)
if(CONFIG_ZMK_RUNTIME_MACRO)
    target_sources(app PRIVATE
        src/runtime_macro.c
        src/runtime_macro_dt_defaults.c
        src/behaviors/behavior_runtime_macro.c
    )

    if(CONFIG_ZMK_RUNTIME_MACRO_TEST)
        target_sources(app PRIVATE tests/ztest/runtime_macro_test.c)
        zephyr_link_libraries(-Wl,--wrap=zmk_custom_setting_public_key)
    endif()

    if(CONFIG_ZMK_RUNTIME_MACRO_DT_DEFAULTS_TEST)
        target_sources(app PRIVATE tests/ztest/runtime_macro_dt_defaults_test.c)
    endif()

    if(CONFIG_ZMK_RUNTIME_MACRO_PLAYBACK_TEST)
        target_sources(app PRIVATE tests/ztest/runtime_macro_playback_test.c)
        zephyr_link_libraries(-Wl,--wrap=zmk_behavior_invoke_binding)
    endif()

    if(CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC)
        target_sources(app PRIVATE src/studio/runtime_macro_handler.c)

        list(APPEND CMAKE_MODULE_PATH ${ZEPHYR_BASE}/modules/nanopb)
        include(nanopb)
        set(NANOPB_GENERATE_CPP_APPEND_PATH TRUE)
        set(NANOPB_GENERATE_CPP_STANDALONE OFF)

        # NOTE: adding to app target directly causes build issues, so we create a library instead
        zephyr_library()
        file(GLOB_RECURSE PROTO_FILES ${CMAKE_CURRENT_SOURCE_DIR}/proto/*.proto)

        # FindNanopb configures .options.in in the build tree; .options remains
        # the standalone protocol-16/32-content-byte generation fallback.
        set(RUNTIME_MACRO_NANOPB_OPTIONS_FILE
            ${CMAKE_CURRENT_SOURCE_DIR}/proto/cormoran/runtime_macro/runtime_macro.options)
        file(READ ${RUNTIME_MACRO_NANOPB_OPTIONS_FILE} RUNTIME_MACRO_NANOPB_OPTIONS)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
                     ${RUNTIME_MACRO_NANOPB_OPTIONS_FILE})

        nanopb_generate_cpp(proto_srcs proto_hdrs RELPATH ${CMAKE_CURRENT_SOURCE_DIR} ${PROTO_FILES})
        target_include_directories(${ZEPHYR_CURRENT_LIBRARY} PUBLIC ${CMAKE_CURRENT_BINARY_DIR})
        target_sources(${ZEPHYR_CURRENT_LIBRARY} PRIVATE ${proto_srcs} ${proto_hdrs})

        # app should depend on the generated proto files
        target_include_directories(app PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/proto)
        add_dependencies(app ${ZEPHYR_CURRENT_LIBRARY})
    endif()
endif()
