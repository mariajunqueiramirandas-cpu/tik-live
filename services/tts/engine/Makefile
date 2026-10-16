# libpocket.so: one binary for every x86-64 CPU with AVX2. Each kernel file is built for its own
# instruction set (AVX2, AVX2 with AVX-VNNI, AVX-512 VNNI, AMX) and picked at startup from cpuid;
# everything else targets x86-64-v2.
CXX ?= g++
OUT ?= build
CXXFLAGS ?= -O3
override CXXFLAGS += -std=c++20 -fPIC -Wall -Wextra -fno-math-errno -fno-trapping-math -fno-plt -pthread
BASE = -march=x86-64-v2 -mtune=generic
AVX2 = -march=x86-64-v2 -mavx2 -mfma -mf16c -mtune=haswell
AVXVNNI = -march=x86-64-v2 -mavx2 -mfma -mf16c -mavxvnni -mtune=alderlake
AVX512 = -march=x86-64-v2 -mavx2 -mfma -mf16c -mavx512f -mavx512bw -mavx512vl -mavx512dq -mavx512vnni -mtune=icelake-server
AMX = $(AVX512) -mavx512bf16 -mamx-tile -mamx-bf16 -mtune=sapphirerapids

SRC = model.cpp lm.cpp mimi.cpp engine.cpp prof.cpp
HDR = $(wildcard *.h)
OBJ = $(SRC:%.cpp=$(OUT)/%.o) $(OUT)/kern_avx2.o $(OUT)/kern_avxvnni.o $(OUT)/kern_avx512.o $(OUT)/kern_amx.o

$(OUT)/libpocket.so: $(OBJ)
	$(CXX) $(CXXFLAGS) -shared -o $@ $^

$(OUT)/kern_avx2.o: kern_avx2.cpp $(HDR) | $(OUT)
	$(CXX) $(CXXFLAGS) $(AVX2) -c $< -o $@

$(OUT)/kern_avxvnni.o: kern_avx2.cpp $(HDR) | $(OUT)
	$(CXX) $(CXXFLAGS) $(AVXVNNI) -c $< -o $@

$(OUT)/kern_avx512.o: kern_avx512.cpp $(HDR) | $(OUT)
	$(CXX) $(CXXFLAGS) $(AVX512) -c $< -o $@

$(OUT)/kern_amx.o: kern_amx.cpp $(HDR) | $(OUT)
	$(CXX) $(CXXFLAGS) $(AMX) -c $< -o $@

$(OUT)/%.o: %.cpp $(HDR) | $(OUT)
	$(CXX) $(CXXFLAGS) $(BASE) -c $< -o $@

$(OUT):
	mkdir -p $@

clean:
	rm -rf $(OUT)

.PHONY: clean
