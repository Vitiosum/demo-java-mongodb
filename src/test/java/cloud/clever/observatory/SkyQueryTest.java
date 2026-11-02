package cloud.clever.observatory;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.bson.Document;
import org.junit.jupiter.api.Test;

class SkyQueryTest {

    private static String filter(String words) {
        return SkyQuery.parse(words).toJson();
    }

    @Test
    void emptyQueryMatchesEverything() {
        assertThat(SkyQuery.parse("  ")).isEqualTo(new Document());
    }

    @Test
    void typeAndPlurals() {
        assertThat(filter("type = planet")).isEqualTo("{\"type\": \"planet\"}");
        assertThat(filter("galaxies")).isEqualTo("{\"type\": \"galaxy\"}");
    }

    @Test
    void numericComparisonUsesTheRealFieldName() {
        assertThat(filter("magnitude < 2")).isEqualTo("{\"magnitude\": {\"$lt\": 2.0}}");
        assertThat(filter("distance >= 1000")).isEqualTo("{\"distanceLy\": {\"$gte\": 1000.0}}");
    }

    @Test
    void hasMoonsMeansANonEmptyArray() {
        assertThat(filter("has moons")).isEqualTo("{\"moons.0\": {\"$exists\": true}}");
        assertThat(filter("has variability")).isEqualTo("{\"variability\": {\"$exists\": true}}");
    }

    @Test
    void constellationLooksAtBothDocumentShapes() {
        assertThat(filter("in constellation ursa major")).isEqualTo(
                "{\"$or\": [{\"constellation\": \"Ursa Major\"}, {\"coordinates.constellation\": \"Ursa Major\"}]}");
    }

    @Test
    void clausesCombineWithAnd() {
        assertThat(filter("comets and period > 50")).isEqualTo(
                "{\"$and\": [{\"type\": \"comet\"}, {\"orbitalPeriodYears\": {\"$gt\": 50.0}}]}");
    }

    @Test
    void nameSearchIsLiteralAndCaseInsensitive() {
        assertThat(filter("name ~ m.42")).isEqualTo("{\"name\": {\"$regex\": \"m\\\\.42\", \"$options\": \"i\"}}");
    }

    @Test
    void unknownWordsAreRefusedWithHelp() {
        assertThatThrownBy(() -> SkyQuery.parse("drop database"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("type = planet");
    }
}
