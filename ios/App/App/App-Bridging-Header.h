// App-Bridging-Header.h
// Hermes Mobile — bridges CPython C API for PythonRuntime.swift.
// Only active when Python.xcframework is linked to the project.

#ifndef App_Bridging_Header_h
#define App_Bridging_Header_h

#if __has_include(<Python/Python.h>)
#include <Python/Python.h>
#define HERMES_PYTHON_AVAILABLE 1
#else
#define HERMES_PYTHON_AVAILABLE 0
#endif

#endif /* App_Bridging_Header_h */
